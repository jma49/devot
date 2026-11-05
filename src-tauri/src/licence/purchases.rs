//! The App Store purchases an App Store build holds (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md,
//! What unlocks the iPhone). StoreKit verified every transaction here; these rules then decide
//! which of them count. The current entitlements, read at launch and on Restore Purchases, replace
//! what is held: StoreKit leaves revoked transactions out of them, so one missing is revoked.
//! Transaction updates change it while the app runs.

use std::collections::BTreeMap;

use crate::app_store::{Entitlements, Ownership, Product, StoreEnvironment, StoreTransaction};

/// The bundle StoreKit signs this app's transactions for. Debug builds rename their data folder
/// and keychain items, never the bundle.
pub(crate) const BUNDLE_ID: &str = "io.github.jma49.devot";
/// The code for an App Store build whose current entitlements have not been read yet.
pub(crate) const UNREAD: &str = "E_APP_STORE_UNREAD";

/// Whether a verified transaction grants `product`: this app's, bought by this Apple account (never
/// family shared), not revoked, in Apple's store or its sandbox. Xcode's local store signs with a
/// certificate of its own, and no App Store build is installed from Xcode.
pub(crate) fn grants(transaction: &StoreTransaction, product: Product) -> bool {
    transaction.product() == Some(product)
        && transaction.bundle_id == BUNDLE_ID
        && transaction.ownership == Ownership::Purchased
        && transaction.revocation_date_ms.is_none()
        && transaction.revocation_reason.is_none()
        && matches!(
            transaction.environment,
            StoreEnvironment::Production | StoreEnvironment::Sandbox
        )
}

#[derive(Debug, Default)]
pub(crate) struct Purchases {
    /// By transaction ID; a revoked one stays, revoked, until the next read replaces it.
    held: BTreeMap<u64, StoreTransaction>,
    read: bool,
    /// Why the last read failed.
    code: Option<&'static str>,
    /// When Devot Pro stopped being held while the app ran, so a save in flight still lands.
    pro_lost_at: Option<i64>,
}

impl Purchases {
    pub(crate) fn read(&self) -> bool {
        self.read
    }

    pub(crate) fn code(&self) -> Option<&'static str> {
        if self.read {
            None
        } else {
            Some(self.code.unwrap_or(UNREAD))
        }
    }

    pub(crate) fn pro(&self) -> bool {
        self.held
            .values()
            .any(|transaction| grants(transaction, Product::Pro))
    }

    /// The App Store's signed transaction for the Devot Pro purchase held, as StoreKit gave it: what
    /// the licence Worker exchanges for a Mac licence key.
    pub(crate) fn pro_transaction(&self) -> Option<&str> {
        self.held
            .values()
            .find(|transaction| grants(transaction, Product::Pro))
            .map(|transaction| transaction.jws.as_str())
    }

    /// When the Trial was first bought by this Apple account, from Apple's signed transaction.
    pub(crate) fn trial_start(&self) -> Option<i64> {
        self.held
            .values()
            .filter(|transaction| grants(transaction, Product::Trial))
            .map(|transaction| transaction.original_purchase_date_ms)
            .min()
    }

    pub(crate) fn in_pro_grace(&self, now: i64, grace_ms: i64) -> bool {
        self.pro_lost_at
            .is_some_and(|lost| (0..grace_ms).contains(&now.saturating_sub(lost)))
    }

    fn changed(&mut self, was_pro: bool, now: i64) {
        if self.pro() {
            self.pro_lost_at = None;
        } else if was_pro {
            self.pro_lost_at = Some(now);
        }
    }

    pub(crate) fn replace(&mut self, entitlements: &Entitlements, now: i64) {
        let was_pro = self.pro();
        self.held = entitlements
            .transactions
            .iter()
            .map(|transaction| (transaction.transaction_id, transaction.clone()))
            .collect();
        self.read = true;
        self.code = None;
        self.changed(was_pro, now);
    }

    /// A read that failed keeps what is held; a launch's first read that fails leaves the build
    /// locked until one succeeds.
    pub(crate) fn failed(&mut self, code: &'static str) {
        self.code = Some(code);
    }

    /// A refund or revocation names the purchase by its original transaction: every transaction of
    /// that purchase goes with it.
    pub(crate) fn apply(&mut self, transaction: StoreTransaction, now: i64) {
        let was_pro = self.pro();
        if transaction.revocation_date_ms.is_some() || transaction.revocation_reason.is_some() {
            let original = transaction.original_transaction_id;
            self.held
                .retain(|_, held| held.original_transaction_id != original);
        }
        self.held.insert(transaction.transaction_id, transaction);
        self.changed(was_pro, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_store::RevocationReason;
    use crate::app_store::fake::transaction;

    const NOW: i64 = 1_790_000_000_000;
    const GRACE: i64 = 5 * 60_000;

    fn held(transactions: Vec<StoreTransaction>) -> Purchases {
        let mut purchases = Purchases::default();
        purchases.replace(
            &Entitlements {
                transactions,
                unverified: Vec::new(),
            },
            NOW,
        );
        purchases
    }

    fn revoked(transaction: StoreTransaction) -> StoreTransaction {
        StoreTransaction {
            revocation_date_ms: Some(NOW),
            revocation_reason: Some(RevocationReason::Other),
            ..transaction
        }
    }

    #[test]
    fn the_bundle_is_the_apps_own() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(config["identifier"], BUNDLE_ID);
    }

    #[test]
    fn a_verified_purchase_by_this_account_grants_its_product_alone() {
        let pro = transaction(Product::Pro, 1, NOW);
        assert!(grants(&pro, Product::Pro));
        assert!(!grants(&pro, Product::Trial));
        let trial = transaction(Product::Trial, 2, NOW);
        assert!(grants(&trial, Product::Trial));
        assert!(!grants(&trial, Product::Pro));
        assert!(grants(
            &StoreTransaction {
                environment: StoreEnvironment::Sandbox,
                ..pro.clone()
            },
            Product::Pro
        ));
    }

    #[test]
    fn nothing_else_grants_anything() {
        let pro = transaction(Product::Pro, 1, NOW);
        let refused = [
            StoreTransaction {
                ownership: Ownership::FamilyShared,
                ..pro.clone()
            },
            StoreTransaction {
                ownership: Ownership::Unknown,
                ..pro.clone()
            },
            StoreTransaction {
                revocation_date_ms: Some(NOW),
                ..pro.clone()
            },
            StoreTransaction {
                revocation_reason: Some(RevocationReason::DeveloperIssue),
                ..pro.clone()
            },
            StoreTransaction {
                bundle_id: "io.github.jma49.devot.dev".to_owned(),
                ..pro.clone()
            },
            StoreTransaction {
                bundle_id: "com.example.other".to_owned(),
                ..pro.clone()
            },
            StoreTransaction {
                product_id: "io.github.jma49.devot.pro2".to_owned(),
                ..pro.clone()
            },
            StoreTransaction {
                product_id: "IO.GITHUB.JMA49.DEVOT.PRO".to_owned(),
                ..pro.clone()
            },
            StoreTransaction {
                environment: StoreEnvironment::Xcode,
                ..pro.clone()
            },
            StoreTransaction {
                environment: StoreEnvironment::Unknown,
                ..pro
            },
        ];
        for transaction in refused {
            assert!(!grants(&transaction, Product::Pro), "{transaction:?}");
            let purchases = held(vec![transaction]);
            assert!(!purchases.pro());
            assert_eq!(purchases.pro_transaction(), None);
        }
    }

    #[test]
    fn hands_over_the_signed_transaction_of_the_pro_purchase_alone() {
        let trial = transaction(Product::Trial, 1, NOW);
        let family = StoreTransaction {
            ownership: Ownership::FamilyShared,
            ..transaction(Product::Pro, 2, NOW)
        };
        assert_eq!(
            held(vec![trial.clone(), family.clone()]).pro_transaction(),
            None
        );
        let pro = transaction(Product::Pro, 3, NOW);
        let purchases = held(vec![trial, family, pro.clone()]);
        assert_eq!(purchases.pro_transaction(), Some(pro.jws.as_str()));
        let mut refunded = purchases;
        refunded.apply(revoked(pro), NOW);
        assert_eq!(refunded.pro_transaction(), None);
    }

    #[test]
    fn the_trial_never_counts_as_pro() {
        let purchases = held(vec![transaction(Product::Trial, 1, NOW)]);
        assert!(!purchases.pro());
        assert_eq!(purchases.trial_start(), Some(NOW));
    }

    #[test]
    fn the_trial_starts_at_its_first_purchase() {
        let first = StoreTransaction {
            original_purchase_date_ms: NOW - 10,
            ..transaction(Product::Trial, 2, NOW)
        };
        let purchases = held(vec![first, transaction(Product::Trial, 3, NOW - 5)]);
        assert_eq!(purchases.trial_start(), Some(NOW - 10));
        let shared = StoreTransaction {
            ownership: Ownership::FamilyShared,
            ..transaction(Product::Trial, 4, NOW)
        };
        assert_eq!(held(vec![shared]).trial_start(), None);
    }

    #[test]
    fn nothing_is_held_until_the_entitlements_are_read() {
        let mut purchases = Purchases::default();
        assert!(!purchases.read());
        assert_eq!(purchases.code(), Some(UNREAD));
        purchases.failed("E_APP_STORE_NO_REPLY");
        assert_eq!(purchases.code(), Some("E_APP_STORE_NO_REPLY"));
        assert!(!purchases.pro());
        purchases.replace(&Entitlements::default(), NOW);
        assert!(purchases.read());
        assert_eq!(purchases.code(), None);
    }

    #[test]
    fn a_purchase_missing_from_a_later_read_is_gone() {
        let mut purchases = held(vec![transaction(Product::Pro, 1, NOW)]);
        assert!(purchases.pro());
        purchases.replace(&Entitlements::default(), NOW + 1);
        assert!(!purchases.pro());
        assert!(purchases.in_pro_grace(NOW + 1, GRACE));
    }

    #[test]
    fn a_failed_read_keeps_what_is_held() {
        let mut purchases = held(vec![transaction(Product::Pro, 1, NOW)]);
        purchases.failed("E_APP_STORE_NO_REPLY");
        assert!(purchases.pro());
    }

    #[test]
    fn an_update_adds_a_purchase_and_a_refund_takes_it_away_with_a_grace() {
        let mut purchases = held(Vec::new());
        purchases.apply(transaction(Product::Pro, 1, NOW), NOW);
        assert!(purchases.pro());
        assert!(!purchases.in_pro_grace(NOW, GRACE));
        purchases.apply(revoked(transaction(Product::Pro, 1, NOW)), NOW + 10);
        assert!(!purchases.pro());
        assert!(purchases.in_pro_grace(NOW + 10, GRACE));
        assert!(purchases.in_pro_grace(NOW + 10 + GRACE - 1, GRACE));
        assert!(!purchases.in_pro_grace(NOW + 10 + GRACE, GRACE));
        assert!(!purchases.in_pro_grace(NOW, GRACE));
    }

    #[test]
    fn a_refund_takes_every_transaction_of_its_purchase() {
        let original = transaction(Product::Pro, 1, NOW);
        let restored = StoreTransaction {
            transaction_id: 2,
            ..original.clone()
        };
        let mut purchases = held(vec![original.clone(), restored]);
        purchases.apply(
            StoreTransaction {
                transaction_id: 3,
                ..revoked(original)
            },
            NOW,
        );
        assert!(!purchases.pro());
    }

    #[test]
    fn a_refund_of_one_purchase_leaves_another() {
        let mut purchases = held(vec![
            transaction(Product::Pro, 1, NOW),
            transaction(Product::Trial, 2, NOW),
        ]);
        purchases.apply(revoked(transaction(Product::Trial, 2, NOW)), NOW);
        assert!(purchases.pro());
        assert_eq!(purchases.trial_start(), None);
        assert!(!purchases.in_pro_grace(NOW, GRACE));
    }

    #[test]
    fn a_launch_without_the_purchase_gives_no_grace() {
        let mut purchases = Purchases::default();
        purchases.replace(&Entitlements::default(), NOW);
        assert!(!purchases.in_pro_grace(NOW, GRACE));
    }
}
