//! The bridge's replies: UTF-8 JSON objects whose `status` names the outcome, the shape
//! `src-tauri/apple/DevotStore/Sources/DevotStore/Reply.swift` writes. Unknown fields are ignored;
//! a missing or mistyped field, an unknown status, or a status the call does not expect is
//! `StoreError::PAYLOAD`. A code from Swift is kept only when it is one of the known codes below,
//! so nothing Swift adds to a reply can reach a log.

use serde::Deserialize;

use super::{
    Entitlements, Finish, Product, Purchase, Restore, StoreError, StoreProduct, StoreTransaction,
    Update,
};

const ERRORS: [&str; 10] = [
    "E_APP_STORE_NETWORK",
    "E_APP_STORE_SYSTEM",
    "E_APP_STORE_NOT_AVAILABLE",
    "E_APP_STORE_NOT_ENTITLED",
    "E_APP_STORE_PRODUCT_UNAVAILABLE",
    "E_APP_STORE_PURCHASE_NOT_ALLOWED",
    "E_APP_STORE_PURCHASE_FAILED",
    "E_APP_STORE_PRODUCT_NOT_FOUND",
    "E_APP_STORE_UNKNOWN_PRODUCT",
    "E_APP_STORE_UNKNOWN",
];

const UNVERIFIED: [&str; 7] = [
    "E_APP_STORE_UNVERIFIED_REVOKED_CERTIFICATE",
    "E_APP_STORE_UNVERIFIED_CERTIFICATE_CHAIN",
    "E_APP_STORE_UNVERIFIED_DEVICE",
    "E_APP_STORE_UNVERIFIED_ENCODING",
    "E_APP_STORE_UNVERIFIED_SIGNATURE",
    "E_APP_STORE_UNVERIFIED_MISSING_PROPERTIES",
    "E_APP_STORE_UNVERIFIED",
];

pub(super) fn known_error(code: &str) -> &'static str {
    ERRORS
        .into_iter()
        .find(|known| *known == code)
        .unwrap_or("E_APP_STORE_UNKNOWN")
}

fn known_unverified(code: &str) -> &'static str {
    UNVERIFIED
        .into_iter()
        .find(|known| *known == code)
        .unwrap_or("E_APP_STORE_UNVERIFIED")
}

#[derive(Deserialize)]
struct ProductReply {
    id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(rename = "displayPrice")]
    display_price: String,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum Reply {
    Products {
        products: Vec<ProductReply>,
    },
    Purchased {
        transaction: StoreTransaction,
    },
    Pending,
    Cancelled,
    Unverified {
        code: String,
    },
    Synced,
    Entitlements {
        transactions: Vec<StoreTransaction>,
        #[serde(default)]
        unverified: Vec<String>,
    },
    Transaction {
        transaction: StoreTransaction,
    },
    Finished,
    NotFound,
    Error {
        code: String,
    },
}

fn read(json: &[u8]) -> Result<Reply, StoreError> {
    match serde_json::from_slice(json) {
        Ok(Reply::Error { code }) => Err(StoreError::from_code(&code)),
        Ok(reply) => Ok(reply),
        Err(_) => Err(StoreError::PAYLOAD),
    }
}

pub(super) fn products(json: &[u8]) -> Result<Vec<StoreProduct>, StoreError> {
    match read(json)? {
        Reply::Products { products } => Ok(products
            .into_iter()
            .filter_map(|reply| {
                Some(StoreProduct {
                    product: Product::from_id(&reply.id)?,
                    display_name: reply.display_name,
                    display_price: reply.display_price,
                })
            })
            .collect()),
        _ => Err(StoreError::PAYLOAD),
    }
}

pub(super) fn purchase(json: &[u8]) -> Result<Purchase, StoreError> {
    match read(json)? {
        Reply::Purchased { transaction } => Ok(Purchase::Purchased(transaction)),
        Reply::Pending => Ok(Purchase::Pending),
        Reply::Cancelled => Ok(Purchase::Cancelled),
        Reply::Unverified { code } => Ok(Purchase::Unverified(known_unverified(&code))),
        _ => Err(StoreError::PAYLOAD),
    }
}

pub(super) fn restore(json: &[u8]) -> Result<Restore, StoreError> {
    match read(json)? {
        Reply::Synced => Ok(Restore::Synced),
        Reply::Cancelled => Ok(Restore::Cancelled),
        _ => Err(StoreError::PAYLOAD),
    }
}

pub(super) fn entitlements(json: &[u8]) -> Result<Entitlements, StoreError> {
    match read(json)? {
        Reply::Entitlements {
            transactions,
            unverified,
        } => Ok(Entitlements {
            transactions,
            unverified: unverified
                .iter()
                .map(|code| known_unverified(code))
                .collect(),
        }),
        _ => Err(StoreError::PAYLOAD),
    }
}

pub(super) fn update(json: &[u8]) -> Result<Update, StoreError> {
    match read(json)? {
        Reply::Transaction { transaction } => Ok(Update::Transaction(transaction)),
        Reply::Unverified { code } => Ok(Update::Unverified(known_unverified(&code))),
        _ => Err(StoreError::PAYLOAD),
    }
}

pub(super) fn finish(json: &[u8]) -> Result<Finish, StoreError> {
    match read(json)? {
        Reply::Finished => Ok(Finish::Finished),
        Reply::NotFound => Ok(Finish::NotFound),
        _ => Err(StoreError::PAYLOAD),
    }
}
