//! StoreKit 2 through the Swift package's C functions (`native::ios`, the only place that calls
//! them). Each call gets one JSON reply, which `payload` reads.

use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};
use tokio::sync::oneshot;

use super::{
    AppStore, Entitlements, Finish, Product, Purchase, Restore, StoreError, StoreProduct, Update,
    payload,
};
use crate::native::ios;

#[derive(Default)]
pub(crate) struct StoreKit {
    listening: AtomicBool,
}

async fn reply(receiver: oneshot::Receiver<Vec<u8>>) -> Result<Vec<u8>, StoreError> {
    receiver.await.map_err(|_| StoreError::NO_REPLY)
}

impl AppStore for StoreKit {
    async fn products(&self) -> Result<Vec<StoreProduct>, StoreError> {
        payload::products(&reply(ios::store_products()).await?)
    }

    async fn purchase(&self, product: Product) -> Result<Purchase, StoreError> {
        payload::purchase(&reply(ios::store_purchase(product.id())).await?)
    }

    async fn restore(&self) -> Result<Restore, StoreError> {
        payload::restore(&reply(ios::store_restore()).await?)
    }

    async fn current_entitlements(&self) -> Result<Entitlements, StoreError> {
        payload::entitlements(&reply(ios::store_entitlements()).await?)
    }

    fn updates(&self) -> Result<UnboundedReceiver<Update>, StoreError> {
        if self.listening.swap(true, Ordering::SeqCst) {
            return Err(StoreError::LISTENING);
        }
        let (sender, receiver) = unbounded_channel();
        let started = ios::store_listen(Box::new(move |json| match payload::update(&json) {
            Ok(update) => {
                let _ = sender.send(update);
            }
            Err(error) => log::warn!("{error} W_APP_STORE_UPDATE_DROPPED"),
        }));
        if started {
            Ok(receiver)
        } else {
            Err(StoreError::LISTENING)
        }
    }

    async fn finish(&self, transaction_id: u64) -> Result<Finish, StoreError> {
        payload::finish(&reply(ios::store_finish(transaction_id)).await?)
    }
}
