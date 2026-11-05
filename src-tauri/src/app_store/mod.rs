//! The App Store as Rust sees it (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md,
//! The native bridge): the two products, a purchase, Restore Purchases, the current entitlements,
//! StoreKit's transaction updates and finishing a transaction. On iOS it is StoreKit 2 through the
//! Swift package `src-tauri/apple/DevotStore` (`storekit`); everywhere else it is `FakeAppStore`.
//! Nothing here decides what unlocks the app: that is the entitlement rules' job.
//! A transaction's JWS never reaches a log, an error or a debug print: logs carry codes only.
#![cfg_attr(
    not(test),
    allow(dead_code, reason = "the entitlements (#609) are its first user")
)]

mod fake;
mod payload;
#[cfg(target_os = "ios")]
mod storekit;
#[cfg(test)]
mod tests;

use std::fmt;
use std::future::Future;

use serde::Deserialize;
use tokio::sync::mpsc::UnboundedReceiver;

pub(crate) use fake::FakeAppStore;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Product {
    Pro,
    Trial,
}

impl Product {
    pub(crate) const ALL: [Product; 2] = [Product::Pro, Product::Trial];

    pub(crate) fn id(self) -> &'static str {
        match self {
            Product::Pro => "io.github.jma49.devot.pro",
            Product::Trial => "io.github.jma49.devot.trial",
        }
    }

    pub(crate) fn from_id(id: &str) -> Option<Product> {
        Product::ALL.into_iter().find(|product| product.id() == id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoreProduct {
    pub(crate) product: Product,
    pub(crate) display_name: String,
    /// The price as StoreKit formats it for the storefront, the only price an App Store build shows.
    pub(crate) display_price: String,
}

/// A transaction StoreKit verified on the device. Dates are milliseconds since the Unix epoch, as
/// in Apple's signed payload.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreTransaction {
    pub(crate) product_id: String,
    pub(crate) transaction_id: u64,
    pub(crate) original_transaction_id: u64,
    pub(crate) bundle_id: String,
    #[serde(rename = "purchaseDate")]
    pub(crate) purchase_date_ms: i64,
    #[serde(rename = "originalPurchaseDate")]
    pub(crate) original_purchase_date_ms: i64,
    #[serde(rename = "revocationDate", default)]
    pub(crate) revocation_date_ms: Option<i64>,
    #[serde(default)]
    pub(crate) revocation_reason: Option<RevocationReason>,
    #[serde(rename = "ownershipType")]
    pub(crate) ownership: Ownership,
    pub(crate) environment: StoreEnvironment,
    /// Apple's signed transaction, for the licence exchange only.
    #[serde(rename = "jwsRepresentation")]
    pub(crate) jws: String,
}

impl StoreTransaction {
    pub(crate) fn product(&self) -> Option<Product> {
        Product::from_id(&self.product_id)
    }
}

impl fmt::Debug for StoreTransaction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoreTransaction")
            .field("product_id", &self.product_id)
            .field("transaction_id", &self.transaction_id)
            .field("original_transaction_id", &self.original_transaction_id)
            .field("bundle_id", &self.bundle_id)
            .field("purchase_date_ms", &self.purchase_date_ms)
            .field("original_purchase_date_ms", &self.original_purchase_date_ms)
            .field("revocation_date_ms", &self.revocation_date_ms)
            .field("revocation_reason", &self.revocation_reason)
            .field("ownership", &self.ownership)
            .field("environment", &self.environment)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub(crate) enum Ownership {
    #[serde(rename = "PURCHASED")]
    Purchased,
    #[serde(rename = "FAMILY_SHARED")]
    FamilyShared,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub(crate) enum StoreEnvironment {
    Production,
    Sandbox,
    Xcode,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RevocationReason {
    DeveloperIssue,
    Other,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Purchase {
    Purchased(StoreTransaction),
    /// Ask to Buy, or a payment that needs action: the transaction arrives later as an update.
    Pending,
    Cancelled,
    /// StoreKit could not verify the transaction; only its code is known.
    Unverified(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Restore {
    Synced,
    Cancelled,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Entitlements {
    pub(crate) transactions: Vec<StoreTransaction>,
    /// The codes of the entitlements StoreKit could not verify.
    pub(crate) unverified: Vec<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Update {
    Transaction(StoreTransaction),
    Unverified(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Finish {
    Finished,
    /// No unfinished transaction has that ID: it was finished already, or never existed.
    NotFound,
}

/// A failure as its code alone, so it can be logged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StoreError(&'static str);

impl StoreError {
    /// The bridge's reply was not what the call expects.
    pub(crate) const PAYLOAD: StoreError = StoreError("E_APP_STORE_PAYLOAD");
    pub(crate) const UNAVAILABLE: StoreError = StoreError("E_APP_STORE_UNAVAILABLE");
    /// The bridge dropped the call without replying.
    pub(crate) const NO_REPLY: StoreError = StoreError("E_APP_STORE_NO_REPLY");
    /// The transaction listener was started already; it runs once per launch.
    pub(crate) const LISTENING: StoreError = StoreError("E_APP_STORE_LISTENING");
    pub(crate) const UNKNOWN: StoreError = StoreError("E_APP_STORE_UNKNOWN");

    /// A code the bridge reports, or `UNKNOWN` for one it does not know.
    pub(crate) fn from_code(code: &str) -> StoreError {
        StoreError(payload::known_error(code))
    }

    pub(crate) fn code(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

pub(crate) trait AppStore: Send + Sync {
    /// The products the storefront sells, with their display price; a product App Store Connect
    /// does not offer is missing from the list.
    fn products(&self) -> impl Future<Output = Result<Vec<StoreProduct>, StoreError>> + Send;
    fn purchase(
        &self,
        product: Product,
    ) -> impl Future<Output = Result<Purchase, StoreError>> + Send;
    /// `AppStore.sync()`; what it restores arrives as updates and in the current entitlements.
    fn restore(&self) -> impl Future<Output = Result<Restore, StoreError>> + Send;
    fn current_entitlements(&self)
    -> impl Future<Output = Result<Entitlements, StoreError>> + Send;
    /// Starts StoreKit's transaction listener; only the first call gets the receiver. Unfinished
    /// transactions, Ask to Buy approvals, purchases on other devices and refunds arrive here.
    fn updates(&self) -> Result<UnboundedReceiver<Update>, StoreError>;
    /// Finishes a transaction once Rust has recorded it.
    fn finish(
        &self,
        transaction_id: u64,
    ) -> impl Future<Output = Result<Finish, StoreError>> + Send;
}

#[cfg(target_os = "ios")]
pub(crate) fn platform() -> storekit::StoreKit {
    storekit::StoreKit::default()
}

#[cfg(not(target_os = "ios"))]
pub(crate) fn platform() -> FakeAppStore {
    FakeAppStore::default()
}
