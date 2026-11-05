//! An App Store build's purchases (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md,
//! What unlocks the iPhone): `run` starts StoreKit's listener at launch, reads the current
//! entitlements and follows the updates for the life of the app; the commands sell the two products
//! and Restore Purchases. What each transaction unlocks is the licence's decision (`purchases`).
//! A transaction is finished only once the licence holds it.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::State as Tauri;

use super::{Licence, Snapshot};
use crate::app_store::{
    self, AppStore, Product, Purchase, Restore, StoreError, StoreTransaction, Update, within,
};
use crate::task;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    /// For every bridge call but a purchase and Restore Purchases.
    pub reply: Duration,
    /// Restore Purchases may ask the user to sign in to the App Store first.
    pub restore: Duration,
    /// How soon a launch's read of the entitlements that failed is tried again.
    pub retry: Duration,
}

impl Limits {
    pub(crate) const DEFAULT: Limits = Limits {
        reply: Duration::from_secs(30),
        restore: Duration::from_secs(300),
        retry: Duration::from_secs(60),
    };
}

pub(crate) struct Storefront<S> {
    store: S,
    licence: Arc<Licence>,
    limits: Limits,
}

/// A product as the purchase sheet shows it: the price is StoreKit's, for the storefront.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductView {
    pub product: &'static str,
    pub display_name: String,
    pub display_price: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Bought {
    Purchased,
    /// Ask to Buy, or a payment that needs action: it arrives later as an update.
    Pending,
    Cancelled,
}

fn product_key(product: Product) -> &'static str {
    match product {
        Product::Pro => "pro",
        Product::Trial => "trial",
    }
}

fn product_of(key: &str) -> Option<Product> {
    Product::ALL
        .into_iter()
        .find(|product| product_key(*product) == key)
}

impl<S: AppStore + 'static> Storefront<S> {
    pub(crate) fn new(store: S, licence: Arc<Licence>, limits: Limits) -> Self {
        Self {
            store,
            licence,
            limits,
        }
    }

    #[cfg(test)]
    pub(crate) fn store(&self) -> &S {
        &self.store
    }

    /// Run once, at launch, before any window can buy (`AppStore`'s rules). A read of the
    /// entitlements that fails is tried again every `retry`; updates wait for the first that works,
    /// so a revocation among them lands after it.
    pub(crate) async fn run(self: Arc<Self>) {
        let updates = self.store.updates();
        if let Err(error) = &updates {
            log::warn!("W_APP_STORE_LISTEN {error}");
        }
        while self.read_entitlements().await.is_err() {
            tokio::time::sleep(self.limits.retry).await;
        }
        let Ok(mut updates) = updates else {
            return;
        };
        while let Some(update) = updates.recv().await {
            match update {
                Update::Transaction(transaction) => self.record(transaction).await,
                Update::Unverified(code) => log::warn!("W_APP_STORE_UNVERIFIED {code}"),
            }
        }
    }

    async fn read_entitlements(&self) -> Result<(), StoreError> {
        let read = within(self.limits.reply, self.store.current_entitlements()).await;
        let outcome = read.as_ref().map(|_| ()).map_err(|error| *error);
        let licence = Arc::clone(&self.licence);
        let taken = task::blocking("E_LICENCE_INTERNAL", move || {
            licence.take_entitlements(read.as_ref().map_err(|error| *error));
            Ok(())
        })
        .await;
        if taken.is_err() {
            log::warn!("W_APP_STORE_ENTITLEMENTS_NOT_TAKEN");
        }
        outcome
    }

    /// Finishing comes after the licence holds the transaction: one that is not finished comes back
    /// as an update at the next launch, so nothing is lost if the app ends in between.
    async fn record(&self, transaction: StoreTransaction) {
        let id = transaction.transaction_id;
        let licence = Arc::clone(&self.licence);
        let taken = task::blocking("E_LICENCE_INTERNAL", move || {
            licence.take_transaction(transaction);
            Ok(())
        })
        .await;
        if taken.is_err() {
            log::warn!("W_APP_STORE_TRANSACTION_NOT_TAKEN");
            return;
        }
        if let Err(error) = within(self.limits.reply, self.store.finish(id)).await {
            log::warn!("W_APP_STORE_FINISH {error}");
        }
    }

    pub(crate) async fn products(&self) -> Result<Vec<ProductView>, StoreError> {
        let products = within(self.limits.reply, self.store.products()).await?;
        Ok(products
            .into_iter()
            .map(|product| ProductView {
                product: product_key(product.product),
                display_name: product.display_name,
                display_price: product.display_price,
            })
            .collect())
    }

    /// No time limit: StoreKit's sheet is open, and the user may take as long as they like.
    pub(crate) async fn purchase(&self, product: Product) -> Result<Bought, StoreError> {
        match self.store.purchase(product).await? {
            Purchase::Purchased(transaction) => {
                self.record(transaction).await;
                Ok(Bought::Purchased)
            }
            Purchase::Pending => Ok(Bought::Pending),
            Purchase::Cancelled => Ok(Bought::Cancelled),
            Purchase::Unverified(code) => {
                log::warn!("W_APP_STORE_UNVERIFIED {code}");
                Err(StoreError::UNVERIFIED)
            }
        }
    }

    /// `AppStore.sync()`, then the current entitlements again, which decide; read even when the
    /// sign-in was cancelled or the sync failed, since they may still have changed.
    pub(crate) async fn restore(&self) -> Result<(), StoreError> {
        match within(self.limits.restore, self.store.restore()).await {
            Ok(Restore::Synced | Restore::Cancelled) => {}
            Err(error) => log::warn!("W_APP_STORE_RESTORE {}", error.code()),
        }
        self.read_entitlements().await
    }
}

/// The storefront, in an App Store build; every other build has none.
pub(crate) struct Shop(pub Option<Arc<Storefront<app_store::Platform>>>);

fn storefront(shop: &Shop) -> Result<Arc<Storefront<app_store::Platform>>, String> {
    shop.0
        .clone()
        .ok_or_else(|| StoreError::UNAVAILABLE.code().to_owned())
}

#[tauri::command]
pub async fn store_products(shop: Tauri<'_, Shop>) -> Result<Vec<ProductView>, String> {
    storefront(&shop)?
        .products()
        .await
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub async fn store_purchase(shop: Tauri<'_, Shop>, product: String) -> Result<Bought, String> {
    let product = product_of(&product).ok_or("E_APP_STORE_UNKNOWN_PRODUCT")?;
    storefront(&shop)?
        .purchase(product)
        .await
        .map_err(|error| error.code().to_owned())
}

/// Restore Purchases: the outcome is the licence's state after it.
#[tauri::command]
pub async fn store_restore(
    shop: Tauri<'_, Shop>,
    licence: Tauri<'_, Arc<Licence>>,
) -> Result<Snapshot, String> {
    storefront(&shop)?
        .restore()
        .await
        .map_err(|error| error.code().to_owned())?;
    task::blocking_with(&licence, "E_LICENCE_INTERNAL", |licence| {
        Ok(licence.snapshot())
    })
    .await
}

#[cfg(test)]
mod tests;
