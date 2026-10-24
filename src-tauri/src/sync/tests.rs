use std::cell::RefCell;
use std::collections::HashMap;

use zeroize::Zeroizing;

use super::record::ChunkAt;
use super::*;

const RECORD: &str = "0192f4c8-7a1b-7c3d-8e9f-0123456789ab";
const PIECE: usize = MAX_CHUNK_BYTES - 29;
// Unoptimised AES-GCM is slow, so the tests that need many chunks seal small ones.
const SMALL: usize = 1000;

#[derive(Default)]
struct MemoryStore(RefCell<HashMap<String, Vec<u8>>>);

impl SecretStore for MemoryStore {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError> {
        Ok(self.0.borrow().get(account).cloned().map(Zeroizing::new))
    }

    fn add(&self, account: &str, secret: &[u8]) -> Result<(), SyncError> {
        self.0.borrow_mut().insert(account.into(), secret.to_vec());
        Ok(())
    }

    fn remove(&self, account: &str) -> Result<bool, SyncError> {
        Ok(self.0.borrow_mut().remove(account).is_some())
    }
}

struct FailingStore;

impl SecretStore for FailingStore {
    fn read(&self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError> {
        Err(SyncError::Keychain(-25293))
    }

    fn add(&self, _: &str, _: &[u8]) -> Result<(), SyncError> {
        Err(SyncError::Keychain(-25293))
    }

    fn remove(&self, _: &str) -> Result<bool, SyncError> {
        Err(SyncError::Keychain(-25293))
    }
}

fn fixed_vault() -> Vault {
    let id = VaultId::from_bytes(hex::<16>("0123456789ab4def8123456789abcdef"));
    let mut key = Zeroizing::new([0; 32]);
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = i as u8;
    }
    Vault::from_parts(id, key)
}

fn hex<const N: usize>(text: &str) -> [u8; N] {
    let bytes: Vec<u8> = (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect();
    bytes.try_into().unwrap()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sample(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 31 % 251) as u8).collect()
}

fn decrypt(vault: &Vault, version: u64, chunks: &[Vec<u8>]) -> Result<Vec<u8>, SyncError> {
    vault
        .decrypt_record(RECORD, version, chunks)
        .map(|plain| plain.to_vec())
}

#[test]
fn records_round_trip_in_chunks_that_fit_a_row() {
    let vault = Vault::generate().unwrap();
    for len in [0, 1, 1000, PIECE + 1] {
        let plaintext = sample(len);
        let chunks = vault.encrypt_record(RECORD, 3, &plaintext).unwrap();
        assert_eq!(chunks.len(), len.div_ceil(PIECE).max(1), "{len} bytes");
        assert!(chunks.iter().all(|c| c.len() <= MAX_CHUNK_BYTES));
        assert_eq!(decrypt(&vault, 3, &chunks).unwrap(), plaintext);
    }
    let plaintext = sample(5 * SMALL + 3);
    let chunks = vault
        .encrypt_in_pieces(RECORD, 3, &plaintext, SMALL)
        .unwrap();
    assert_eq!(chunks.len(), 6);
    assert_eq!(decrypt(&vault, 3, &chunks).unwrap(), plaintext);
}

#[test]
fn every_chunk_has_a_fresh_nonce() {
    let vault = Vault::generate().unwrap();
    let plaintext = sample(2 * SMALL + 1);
    let first = vault
        .encrypt_in_pieces(RECORD, 1, &plaintext, SMALL)
        .unwrap();
    let second = vault
        .encrypt_in_pieces(RECORD, 1, &plaintext, SMALL)
        .unwrap();
    let mut nonces: Vec<&[u8]> = first.iter().chain(&second).map(|c| &c[1..13]).collect();
    nonces.sort();
    nonces.dedup();
    assert_eq!(nonces.len(), 6);
    assert_ne!(first, second);
}

#[test]
fn a_record_past_the_limit_is_refused() {
    let vault = Vault::generate().unwrap();
    let larger = vec![7; MAX_RECORD_BYTES + 1];
    assert_eq!(
        vault.encrypt_record(RECORD, 1, &larger),
        Err(SyncError::RecordTooLarge)
    );
    let chunk = vault.encrypt_record(RECORD, 1, b"x").unwrap().remove(0);
    let most = MAX_RECORD_BYTES.div_ceil(PIECE);
    assert_eq!(
        decrypt(&vault, 1, &vec![chunk.clone(); most]),
        Err(SyncError::ChunkAuth)
    );
    assert_eq!(
        decrypt(&vault, 1, &vec![chunk; most + 1]),
        Err(SyncError::RecordTooLarge)
    );
}

#[test]
fn a_tampered_chunk_set_never_opens() {
    let vault = Vault::generate().unwrap();
    let chunks = vault
        .encrypt_in_pieces(RECORD, 5, &sample(2 * SMALL + 9), SMALL)
        .unwrap();
    let other_record = vault
        .encrypt_in_pieces(
            "0192f4c8-0000-7000-8000-000000000000",
            5,
            &sample(2 * SMALL + 9),
            SMALL,
        )
        .unwrap();
    let older = vault
        .encrypt_in_pieces(RECORD, 4, &sample(2 * SMALL + 9), SMALL)
        .unwrap();
    let other_vault = Vault::generate()
        .unwrap()
        .encrypt_in_pieces(RECORD, 5, &sample(2 * SMALL + 9), SMALL)
        .unwrap();
    let auth = Err(SyncError::ChunkAuth);

    let mut swapped = chunks.clone();
    swapped.swap(0, 1);
    assert_eq!(decrypt(&vault, 5, &swapped), auth, "reordered");

    let mut mixed = chunks.clone();
    mixed[1] = other_record[1].clone();
    assert_eq!(
        decrypt(&vault, 5, &mixed),
        auth,
        "swapped from another record"
    );
    assert_eq!(
        decrypt(&vault, 5, &other_record),
        auth,
        "another record's ID"
    );

    assert_eq!(
        decrypt(&vault, 5, &older),
        auth,
        "an older version replayed"
    );
    let mut stale = chunks.clone();
    stale[2] = older[2].clone();
    assert_eq!(
        decrypt(&vault, 5, &stale),
        auth,
        "a chunk of an older version"
    );
    assert_eq!(
        decrypt(&vault, 6, &chunks),
        auth,
        "a version the record was not sealed as"
    );

    assert_eq!(decrypt(&vault, 5, &other_vault), auth, "another vault");

    assert_eq!(decrypt(&vault, 5, &chunks[..2]), auth, "truncated set");
    let mut extended = chunks.clone();
    extended.push(chunks[2].clone());
    assert_eq!(decrypt(&vault, 5, &extended), auth, "extended set");
    let mut repeated = chunks.clone();
    repeated[1] = chunks[0].clone();
    assert_eq!(
        decrypt(&vault, 5, &repeated),
        auth,
        "a chunk replayed in place of another"
    );

    for at in [1, 12, 13, 400, chunks[0].len() - 1] {
        let mut flipped = chunks.clone();
        flipped[0][at] ^= 0x01;
        assert_eq!(decrypt(&vault, 5, &flipped), auth, "bit flipped at {at}");
    }

    let mut cut = chunks.clone();
    cut[2].pop();
    assert_eq!(decrypt(&vault, 5, &cut), auth, "a chunk cut short");
    let mut grown = chunks.clone();
    grown[2].push(0);
    assert_eq!(
        decrypt(&vault, 5, &grown),
        auth,
        "a chunk with a byte added"
    );
}

#[test]
fn malformed_input_fails_with_its_code() {
    let vault = Vault::generate().unwrap();
    let chunks = vault.encrypt_record(RECORD, 1, b"note").unwrap();
    let none: [Vec<u8>; 0] = [];
    assert_eq!(decrypt(&vault, 1, &none), Err(SyncError::NoChunks));
    assert_eq!(
        decrypt(&vault, 1, &[vec![1; 28]]),
        Err(SyncError::ChunkSize)
    );
    assert_eq!(
        decrypt(&vault, 1, &[vec![1; MAX_CHUNK_BYTES + 1]]),
        Err(SyncError::ChunkSize)
    );
    let mut format = chunks.clone();
    format[0][0] = 2;
    assert_eq!(decrypt(&vault, 1, &format), Err(SyncError::ChunkFormat));

    let long = "a".repeat(65);
    for id in ["", "note/1", "n\u{e9}", long.as_str()] {
        assert_eq!(vault.encrypt_record(id, 1, b"x"), Err(SyncError::RecordId));
        assert_eq!(
            vault.decrypt_record(id, 1, &chunks),
            Err(SyncError::RecordId)
        );
    }
    assert!(vault.encrypt_record(&"a".repeat(64), 1, b"x").is_ok());
}

#[test]
fn sealing_matches_known_answers() {
    let vault = fixed_vault();
    let at = ChunkAt {
        record_id: RECORD,
        version: 7,
        index: 0,
        count: 1,
    };
    let nonce = hex::<12>("a0a1a2a3a4a5a6a7a8a9aaab");
    let chunk = vault.seal_chunk(nonce, &at, b"devot sync").unwrap();
    assert_eq!(
        to_hex(&chunk),
        "01a0a1a2a3a4a5a6a7a8a9aaabb90d0135dd9ce2b9db353b742f506a2205a2cbd39da9de104043"
    );
    assert_eq!(&decrypt(&vault, 7, &[chunk]).unwrap(), b"devot sync");

    let at = ChunkAt {
        record_id: RECORD,
        version: 1,
        index: 2,
        count: 3,
    };
    let empty = vault.seal_chunk(nonce, &at, b"").unwrap();
    assert_eq!(
        to_hex(&empty),
        "01a0a1a2a3a4a5a6a7a8a9aaab1616f04dcca182c39a33a1b32a937e8a"
    );
}

#[test]
fn the_enrollment_secret_matches_known_answers() {
    let vault = fixed_vault();
    let secret = vault.enrollment_secret();
    assert_eq!(
        to_hex(secret.as_ref()),
        "89a0b71f4097d394c4618e45d1747e030c4f606b586995e6ecfdac1d7a313642"
    );
    assert_eq!(
        to_hex(&enrollment_verifier(&secret)),
        "1a0d5e2e2be76b6590a26f223e6f525b737af439565c30a513c51145a57d13e6"
    );
    assert_ne!(secret.as_ref(), vault.key());
    let other = Vault::generate().unwrap();
    assert_ne!(other.enrollment_secret(), secret);
}

#[test]
fn the_recovery_key_matches_known_answers_and_reads_back() {
    let vault = fixed_vault();
    let recovery = vault.recovery_key();
    assert_eq!(
        recovery.as_str(),
        "040J6-HB7H6-NMVVW-14D2P-F2DBS-QQG00-820C2-0A1G7-104GM-2RC1M-70Y40-H289H-858P2-WC1J6-GV3GE-HW7Y3-5C2K6"
    );
    let store = MemoryStore::default();
    let restored = Vault::restore(&store, &recovery).unwrap();
    assert_eq!(restored.id(), vault.id());
    assert_eq!(restored.key(), vault.key());

    let fresh = Vault::generate().unwrap();
    let (id, key) = recovery::decode(&fresh.recovery_key()).unwrap();
    assert_eq!((id, &*key), (fresh.id(), fresh.key()));
}

#[test]
fn reading_a_recovery_key_forgives_case_spacing_and_look_alikes() {
    let vault = fixed_vault();
    let typed = vault
        .recovery_key()
        .replace('-', " ")
        .replace('0', "o")
        .replace('1', "L")
        .to_lowercase();
    let (id, _) = recovery::decode(&format!("  {typed}\n")).unwrap();
    assert_eq!(id, vault.id());
    let packed = vault.recovery_key().replace('-', "");
    assert_eq!(recovery::decode(&packed).unwrap().0, vault.id());
}

#[test]
fn a_mistyped_recovery_key_is_refused() {
    let good = fixed_vault().recovery_key().replace('-', "");
    let alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    for at in [0, 3, 40, 83] {
        let mut chars: Vec<char> = good.chars().collect();
        let next = alphabet
            .chars()
            .cycle()
            .skip_while(|&c| c != chars[at])
            .nth(1)
            .unwrap();
        chars[at] = next;
        let typo: String = chars.into_iter().collect();
        assert_eq!(
            recovery::decode(&typo).map(|_| ()),
            Err(SyncError::RecoveryChecksum),
            "typo at {at}"
        );
    }
    let mut swapped: Vec<char> = good.chars().collect();
    swapped.swap(10, 11);
    if swapped[10] != swapped[11] {
        let swapped: String = swapped.into_iter().collect();
        assert_eq!(
            recovery::decode(&swapped).map(|_| ()),
            Err(SyncError::RecoveryChecksum)
        );
    }
    let format = Err(SyncError::RecoveryFormat);
    assert_eq!(
        recovery::decode(&good[1..]).map(|_| ()),
        format,
        "too short"
    );
    assert_eq!(
        recovery::decode(&format!("{good}0")).map(|_| ()),
        format,
        "too long"
    );
    assert_eq!(
        recovery::decode(&format!("U{}", &good[1..])).map(|_| ()),
        format,
        "not in the alphabet"
    );
    let mut padded: Vec<char> = good.chars().collect();
    let last = alphabet.find(padded[84]).unwrap() | 1;
    padded[84] = alphabet.as_bytes()[last] as char;
    let padded: String = padded.into_iter().collect();
    assert_eq!(
        recovery::decode(&padded).map(|_| ()),
        format,
        "padding bit set"
    );
    assert_eq!(recovery::decode("").map(|_| ()), format);
}

#[test]
fn a_recovery_key_of_another_version_is_refused() {
    let vault = fixed_vault();
    let mut payload = vec![2u8];
    payload.extend_from_slice(vault.id().as_bytes());
    payload.extend_from_slice(vault.key());
    let digest = {
        use sha2::{Digest, Sha256};
        Sha256::new()
            .chain_update(b"devot/sync/recovery/v1")
            .chain_update(&payload)
            .finalize()
    };
    payload.extend_from_slice(&digest[..4]);
    let alphabet = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut text = String::new();
    let (mut acc, mut bits) = (0u32, 0);
    for byte in payload {
        acc = (acc << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            text.push(alphabet[((acc >> bits) & 31) as usize] as char);
        }
    }
    text.push(alphabet[((acc << (5 - bits)) & 31) as usize] as char);
    assert_eq!(
        recovery::decode(&text).map(|_| ()),
        Err(SyncError::RecoveryVersion)
    );
}

#[test]
fn a_vault_is_created_loaded_and_deleted_in_its_store() {
    let store = MemoryStore::default();
    assert!(Vault::load(&store).unwrap().is_none());
    let vault = Vault::create(&store).unwrap();
    let loaded = Vault::load(&store).unwrap().unwrap();
    assert_eq!(loaded.id(), vault.id());
    let chunks = vault.encrypt_record(RECORD, 1, b"body").unwrap();
    assert_eq!(&decrypt(&loaded, 1, &chunks).unwrap(), b"body");

    assert_eq!(
        Vault::create(&store).map(|_| ()),
        Err(SyncError::VaultExists)
    );
    assert_eq!(
        Vault::restore(&store, &fixed_vault().recovery_key()).map(|_| ()),
        Err(SyncError::VaultExists)
    );
    assert_eq!(Vault::load(&store).unwrap().unwrap().id(), vault.id());

    assert!(Vault::delete(&store).unwrap());
    assert!(Vault::load(&store).unwrap().is_none());
    assert!(!Vault::delete(&store).unwrap());
}

#[test]
fn a_generated_vault_id_is_a_uuid_v4() {
    let id = Vault::generate().unwrap().id().to_string();
    let parsed = uuid::Uuid::parse_str(&id).unwrap();
    assert_eq!(parsed.get_version_num(), 4);
    assert_eq!(parsed.hyphenated().to_string(), id);
}

#[test]
fn a_damaged_keychain_item_is_refused() {
    let vault = fixed_vault();
    let mut item = vec![1];
    item.extend_from_slice(vault.id().as_bytes());
    item.extend_from_slice(vault.key());
    for damaged in [
        vec![],
        vec![2; 49],
        item[..48].to_vec(),
        [&item[..], &[0]].concat(),
    ] {
        let store = MemoryStore::default();
        store.add("vault", &damaged).unwrap();
        assert_eq!(
            Vault::load(&store).map(|_| ()),
            Err(SyncError::VaultCorrupt)
        );
    }
    let store = MemoryStore::default();
    store.add("vault", &item).unwrap();
    assert_eq!(Vault::load(&store).unwrap().unwrap().key(), vault.key());
}

#[test]
fn keychain_failures_pass_their_status() {
    assert_eq!(
        Vault::load(&FailingStore).map(|_| ()),
        Err(SyncError::Keychain(-25293))
    );
    assert_eq!(
        Vault::create(&FailingStore).map(|_| ()),
        Err(SyncError::Keychain(-25293))
    );
    assert_eq!(
        Vault::delete(&FailingStore),
        Err(SyncError::Keychain(-25293))
    );
    assert_eq!(
        SyncError::Keychain(-25293).to_string(),
        "E_SYNC_KEYCHAIN -25293"
    );
}

#[test]
fn a_debug_build_keeps_its_own_keychain_item() {
    assert_eq!(
        Keychain::for_app("io.github.jma49.devot").service(),
        "io.github.jma49.devot.sync"
    );
    assert_eq!(
        Keychain::for_app("io.github.jma49.devot.dev").service(),
        "io.github.jma49.devot.dev.sync"
    );
}

#[test]
fn no_key_material_reaches_a_log_line_debug_output_or_an_error() {
    crate::test_log::capture();
    let store = MemoryStore::default();
    let vault = Vault::create(&store).unwrap();
    let secrets = [
        to_hex(vault.key()),
        format!("{:?}", vault.key()),
        to_hex(vault.enrollment_secret().as_ref()),
        vault.recovery_key().replace('-', ""),
        vault.recovery_key()[..17].to_string(),
    ];

    let chunks = vault.encrypt_record(RECORD, 1, b"secret body").unwrap();
    let mut seen = vec![format!("{vault:?}"), format!("{:?}", Vault::load(&store))];
    let mut tampered = chunks.clone();
    tampered[0][20] ^= 1;
    let failures = [
        vault.decrypt_record(RECORD, 1, &tampered).map(|_| ()),
        vault.decrypt_record(RECORD, 2, &chunks).map(|_| ()),
        vault.encrypt_record("bad/id", 1, b"x").map(|_| ()),
        Vault::create(&store).map(|_| ()),
        Vault::restore(&store, &vault.recovery_key()).map(|_| ()),
        Vault::restore(&MemoryStore::default(), &vault.recovery_key()[1..]).map(|_| ()),
        recovery::decode(&vault.recovery_key().replacen('0', "1", 1)).map(|_| ()),
        Vault::load(&FailingStore).map(|_| ()),
    ];
    for failure in failures {
        let error = failure.unwrap_err();
        seen.push(error.to_string());
        seen.push(format!("{error:?}"));
    }
    seen.extend(crate::test_log::lines());

    for line in &seen {
        assert!(!line.contains("secret body"), "{line}");
        for secret in &secrets {
            assert!(!line.contains(secret.as_str()), "{line}");
        }
    }
    assert!(format!("{vault:?}").contains(&vault.id().to_string()));
}

/// Writes, reads and removes an item in the login keychain under a throwaway service. Run it on a
/// Mac by hand: `cargo test sync::tests::the_keychain -- --ignored`.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "touches the user's login keychain"]
fn the_keychain_keeps_and_removes_a_vault() {
    struct Cleanup<'a>(&'a Keychain);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            let _ = self.0.remove("vault");
        }
    }
    let identifier = format!("io.github.jma49.devot.test-{}", uuid::Uuid::new_v4());
    let keychain = Keychain::for_app(&identifier);
    let _cleanup = Cleanup(&keychain);
    assert!(Vault::load(&keychain).unwrap().is_none());
    let vault = Vault::create(&keychain).unwrap();
    assert_eq!(
        Vault::create(&keychain).map(|_| ()),
        Err(SyncError::VaultExists)
    );
    let loaded = Vault::load(&keychain).unwrap().unwrap();
    assert_eq!((loaded.id(), loaded.key()), (vault.id(), vault.key()));
    assert!(Vault::delete(&keychain).unwrap());
    assert!(Vault::load(&keychain).unwrap().is_none());
    assert!(!Vault::delete(&keychain).unwrap());
}
