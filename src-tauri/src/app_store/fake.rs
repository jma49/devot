//! The App Store off iOS, and in tests. Empty, it is a device without the store: no products, no
//! entitlements, and a purchase or restore fails with `E_APP_STORE_UNAVAILABLE`. Tests script it
//! the way StoreKit Test scripts StoreKit: what a purchase gives, the products, a refund, updates.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard};

use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use super::{
    AppStore, Entitlements, Finish, Ownership, Product, Purchase, Restore, RevocationReason,
    StoreEnvironment, StoreError, StoreProduct, StoreTransaction, Update,
};

#[derive(Default)]
pub(crate) struct FakeAppStore {
    state: Mutex<State>,
}

struct State {
    products: Result<Vec<StoreProduct>, StoreError>,
    purchases: HashMap<Product, Result<Purchase, StoreError>>,
    restore: Result<Restore, StoreError>,
    entitlements: Vec<StoreTransaction>,
    unfinished: Vec<u64>,
    finished: Vec<u64>,
    purchased: Vec<Product>,
    /// Updates sent before the listener starts, which StoreKit also delivers once it does.
    queued: VecDeque<Update>,
    listener: Option<UnboundedSender<Update>>,
    listening: bool,
}

impl Default for State {
    fn default() -> State {
        State {
            products: Ok(Vec::new()),
            purchases: HashMap::new(),
            restore: Err(StoreError::UNAVAILABLE),
            entitlements: Vec::new(),
            unfinished: Vec::new(),
            finished: Vec::new(),
            purchased: Vec::new(),
            queued: VecDeque::new(),
            listener: None,
            listening: false,
        }
    }
}

impl State {
    fn record(&mut self, transaction: &StoreTransaction) {
        self.entitlements
            .retain(|held| held.transaction_id != transaction.transaction_id);
        if transaction.revocation_date_ms.is_none() {
            self.entitlements.push(transaction.clone());
        }
        if !self.unfinished.contains(&transaction.transaction_id) {
            self.unfinished.push(transaction.transaction_id);
        }
    }

    fn send(&mut self, update: Update) {
        if let Update::Transaction(transaction) = &update {
            self.record(transaction);
        }
        match &self.listener {
            Some(listener) => {
                let _ = listener.send(update);
            }
            None => self.queued.push_back(update),
        }
    }
}

impl FakeAppStore {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn set_products(&self, products: Result<Vec<StoreProduct>, StoreError>) {
        self.state().products = products;
    }

    /// What every purchase of `product` gives from now on.
    pub(crate) fn set_purchase(&self, product: Product, outcome: Result<Purchase, StoreError>) {
        self.state().purchases.insert(product, outcome);
    }

    pub(crate) fn set_restore(&self, outcome: Result<Restore, StoreError>) {
        self.state().restore = outcome;
    }

    pub(crate) fn set_entitlements(&self, transactions: Vec<StoreTransaction>) {
        let mut state = self.state();
        state.entitlements.clear();
        for transaction in &transactions {
            state.record(transaction);
        }
    }

    /// A transaction update, as from an Ask to Buy approval or a purchase on another device.
    pub(crate) fn push_update(&self, update: Update) {
        self.state().send(update);
    }

    /// Apple refunds the transaction: it leaves the entitlements and arrives revoked as an update.
    pub(crate) fn refund(&self, transaction_id: u64, revocation_date_ms: i64) {
        let mut state = self.state();
        let Some(held) = state
            .entitlements
            .iter()
            .find(|held| held.transaction_id == transaction_id)
            .cloned()
        else {
            return;
        };
        state.send(Update::Transaction(StoreTransaction {
            revocation_date_ms: Some(revocation_date_ms),
            revocation_reason: Some(RevocationReason::Other),
            ..held
        }));
    }

    pub(crate) fn purchased(&self) -> Vec<Product> {
        self.state().purchased.clone()
    }

    pub(crate) fn finished(&self) -> Vec<u64> {
        self.state().finished.clone()
    }
}

impl AppStore for FakeAppStore {
    async fn products(&self) -> Result<Vec<StoreProduct>, StoreError> {
        self.state().products.clone()
    }

    async fn purchase(&self, product: Product) -> Result<Purchase, StoreError> {
        let mut state = self.state();
        state.purchased.push(product);
        let outcome = state
            .purchases
            .get(&product)
            .cloned()
            .unwrap_or(Err(StoreError::UNAVAILABLE));
        if let Ok(Purchase::Purchased(transaction)) = &outcome {
            state.record(transaction);
        }
        outcome
    }

    async fn restore(&self) -> Result<Restore, StoreError> {
        self.state().restore
    }

    async fn current_entitlements(&self) -> Result<Entitlements, StoreError> {
        Ok(Entitlements {
            transactions: self.state().entitlements.clone(),
            unverified: Vec::new(),
        })
    }

    fn updates(&self) -> Result<UnboundedReceiver<Update>, StoreError> {
        let mut state = self.state();
        if state.listening {
            return Err(StoreError::LISTENING);
        }
        state.listening = true;
        let (sender, receiver) = unbounded_channel();
        for update in state.queued.drain(..) {
            let _ = sender.send(update);
        }
        state.listener = Some(sender);
        Ok(receiver)
    }

    async fn finish(&self, transaction_id: u64) -> Result<Finish, StoreError> {
        let mut state = self.state();
        let Some(index) = state.unfinished.iter().position(|id| *id == transaction_id) else {
            return Ok(Finish::NotFound);
        };
        state.unfinished.remove(index);
        state.finished.push(transaction_id);
        Ok(Finish::Finished)
    }
}

/// A verified production purchase of `product` by this account, for tests.
pub(crate) fn transaction(
    product: Product,
    transaction_id: u64,
    purchase_date_ms: i64,
) -> StoreTransaction {
    StoreTransaction {
        product_id: product.id().to_owned(),
        transaction_id,
        original_transaction_id: transaction_id,
        bundle_id: "io.github.jma49.devot".to_owned(),
        purchase_date_ms,
        original_purchase_date_ms: purchase_date_ms,
        revocation_date_ms: None,
        revocation_reason: None,
        ownership: Ownership::Purchased,
        environment: StoreEnvironment::Production,
        jws: format!("fake.jws.{transaction_id}"),
    }
}
