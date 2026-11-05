use super::pairing::{self, Pairing, PairingChannel, RelayPairing, TTL_MS};
use super::tests::{MemoryStore, fixed_vault, to_hex};
use super::{SyncError, Vault};

const RECORD: &str = "0192f4c8-7a1b-7c3d-8e9f-0123456789ab";
const NOW: i64 = 1_790_000_000_000;
const SKEW_MS: i64 = 5 * 60_000;

fn fixed_pairing() -> Pairing {
    pairing::from_secret_for_tests(std::array::from_fn(|i| (i * 7) as u8))
}

fn relay() -> super::client::RelayUrl {
    super::client::RelayUrl::parse("https://relay.example.com").unwrap()
}

/// Whether `vault` holds the same key as `expected`: what one seals, the other opens.
fn same_vault(vault: &Vault, expected: &Vault) -> bool {
    let sealed = expected.encrypt_record(RECORD, 1, b"body").unwrap();
    vault.id() == expected.id()
        && vault
            .decrypt_record(RECORD, 1, &sealed)
            .is_ok_and(|plain| plain.as_slice() == b"body")
}

#[test]
fn a_pairing_code_matches_known_answers_and_reads_back() {
    let pairing = fixed_pairing();
    assert_eq!(
        pairing.code().as_str(),
        "0400-E3GN-3GHJ-MC9R-7X34-TN2V-C9MN-JTDF"
    );
    assert_eq!(pairing.id(), "tfl_cHQHg_4lZ18SS4prSg");
    let read = pairing::read(&pairing.code()).unwrap();
    assert_eq!(read.pairing.id(), pairing.id());
    assert!(read.relay.is_none());

    let fresh = Pairing::generate().unwrap();
    let code = fresh.code();
    assert_eq!(code.len(), 39);
    assert!(code.split('-').all(|group| group.len() == 4));
    assert_ne!(fresh.id(), pairing.id());
    assert_eq!(pairing::read(&code).unwrap().pairing.id(), fresh.id());
}

#[test]
fn reading_a_pairing_code_forgives_case_spacing_and_look_alikes() {
    let pairing = fixed_pairing();
    let typed = pairing
        .code()
        .to_lowercase()
        .replace('0', "o")
        .replace('1', "l")
        .replace('-', " ");
    assert_eq!(
        pairing::read(&format!("  {typed}\n")).unwrap().pairing.id(),
        pairing.id()
    );
    let packed = pairing.code().replace('-', "");
    assert_eq!(pairing::read(&packed).unwrap().pairing.id(), pairing.id());
}

#[test]
fn a_mistyped_or_foreign_code_is_refused_before_anything_goes_out() {
    let good = fixed_pairing().code().replace('-', "");
    let mut typo = good.clone().into_bytes();
    typo[10] = if typo[10] == b'A' { b'B' } else { b'A' };
    let typo = String::from_utf8(typo).unwrap();
    let error = |text: &str| pairing::read(text).map(|_| ()).unwrap_err();
    assert_eq!(error(&typo), SyncError::PairingChecksum);
    assert_eq!(error(&good[1..]), SyncError::PairingFormat);
    assert_eq!(error(&format!("{good}0")), SyncError::PairingFormat);
    assert_eq!(error(&format!("U{}", &good[1..])), SyncError::PairingFormat);
    assert_eq!(error(""), SyncError::PairingFormat);
    assert_eq!(
        error(&fixed_vault().recovery_key()),
        SyncError::PairingFormat
    );
    assert_eq!(error(&"A".repeat(5000)), SyncError::PairingFormat);
}

#[test]
fn the_link_carries_the_relay_and_the_code() {
    let pairing = fixed_pairing();
    let link = pairing.link(&relay());
    assert_eq!(
        link.as_str(),
        "devot://pair?relay=https%3A%2F%2Frelay.example.com&code=0400E3GN3GHJMC9R7X34TN2VC9MNJTDF"
    );
    let read = pairing::read(&format!(" {} ", link.as_str())).unwrap();
    assert_eq!(read.pairing.id(), pairing.id());
    assert_eq!(read.relay, Some(relay()));

    let code = pairing.code().replace('-', "");
    for bad in [
        format!("devot://note/x?relay=https%3A%2F%2Frelay.example.com&code={code}"),
        format!("devot://pair?relay=http%3A%2F%2Frelay.example.com&code={code}"),
        format!("devot://pair?code={code}"),
        "devot://pair?relay=https%3A%2F%2Frelay.example.com".to_string(),
        format!(
            "devot://pair?relay=https%3A%2F%2Fa.example&relay=https%3A%2F%2Fb.example&code={code}"
        ),
        format!("devot://pair?relay=https%3A%2F%2Frelay.example.com&code={code}&more=1"),
        format!("https://relay.example.com/?code={code}"),
    ] {
        assert!(pairing::read(&bad).is_err(), "{bad}");
    }
}

#[test]
fn the_offer_hands_over_the_vault_to_the_code_holder_only() {
    let vault = fixed_vault();
    let pairing = fixed_pairing();
    let offer = pairing.seal_offer(&vault, NOW + TTL_MS).unwrap();
    assert_eq!(offer.len(), 1 + 12 + 57 + 16);
    let joined = pairing::read(&pairing.code()).unwrap().pairing;
    assert!(same_vault(&joined.open_offer(&offer, NOW).unwrap(), &vault));

    let raw = offer.windows(32).any(|w| w == vault.key());
    assert!(!raw, "the key never travels in the clear");
    let other = Pairing::generate().unwrap();
    assert_eq!(
        other.open_offer(&offer, NOW).map(|_| ()),
        Err(SyncError::PairingAuth)
    );
    for at in [0, 5, 20, offer.len() - 1] {
        let mut tampered = offer.clone();
        tampered[at] ^= 1;
        assert_eq!(
            joined.open_offer(&tampered, NOW).map(|_| ()),
            Err(SyncError::PairingAuth),
            "byte {at}"
        );
    }
    assert_eq!(
        joined.open_offer(&offer[..20], NOW).map(|_| ()),
        Err(SyncError::PairingAuth)
    );
    assert_eq!(
        joined.open_offer(&[], NOW).map(|_| ()),
        Err(SyncError::PairingAuth)
    );
}

#[test]
fn a_substituted_swapped_or_role_swapped_message_does_not_open() {
    let vault = fixed_vault();
    let pairing = fixed_pairing();
    // The relay's own vault, sealed under a code it made: what it would hand the joining device.
    let relays = Pairing::generate().unwrap();
    let theirs = Vault::generate().unwrap();
    let substitute = relays.seal_offer(&theirs, NOW + TTL_MS).unwrap();
    assert_eq!(
        pairing.open_offer(&substitute, NOW).map(|_| ()),
        Err(SyncError::PairingAuth)
    );
    // Another pairing's real offer.
    let swapped = relays.seal_offer(&vault, NOW + TTL_MS).unwrap();
    assert_eq!(
        pairing.open_offer(&swapped, NOW).map(|_| ()),
        Err(SyncError::PairingAuth)
    );
    // A confirmation passed off as an offer, and the other way round.
    let confirmation = pairing.seal_confirmation("device-1").unwrap();
    assert_eq!(
        pairing.open_offer(&confirmation, NOW).map(|_| ()),
        Err(SyncError::PairingAuth)
    );
    let offer = pairing.seal_offer(&vault, NOW + TTL_MS).unwrap();
    assert_eq!(
        pairing.open_confirmation(&offer),
        Err(SyncError::PairingAuth)
    );
    assert_eq!(
        pairing.open_confirmation(&relays.seal_confirmation("device-1").unwrap()),
        Err(SyncError::PairingAuth)
    );
    assert_eq!(
        pairing.open_confirmation(&confirmation).as_deref(),
        Ok("device-1")
    );
    assert_eq!(
        pairing.seal_confirmation("").map(|_| ()),
        Err(SyncError::PairingAuth)
    );
}

#[test]
fn an_offer_past_its_expiry_is_refused_by_the_device() {
    let vault = fixed_vault();
    let pairing = fixed_pairing();
    let offer = pairing.seal_offer(&vault, NOW).unwrap();
    assert!(pairing.open_offer(&offer, NOW + SKEW_MS).is_ok());
    assert_eq!(
        pairing.open_offer(&offer, NOW + SKEW_MS + 1).map(|_| ()),
        Err(SyncError::PairingExpired)
    );
}

#[test]
fn joining_keeps_a_new_vault_or_the_same_one_and_never_replaces_another() {
    let store = MemoryStore::default();
    let vault = fixed_vault();
    let pairing = fixed_pairing();
    let offer = pairing.seal_offer(&vault, NOW + TTL_MS).unwrap();
    let kept = Vault::join(&store, pairing.open_offer(&offer, NOW).unwrap()).unwrap();
    assert!(same_vault(&kept, &vault));
    let again = Vault::join(&store, pairing.open_offer(&offer, NOW).unwrap()).unwrap();
    assert!(same_vault(&again, &vault));
    assert_eq!(
        Vault::join(&store, Vault::generate().unwrap()).map(|_| ()),
        Err(SyncError::VaultExists)
    );
    assert!(same_vault(&Vault::load(&store).unwrap().unwrap(), &vault));
}

#[test]
fn no_pairing_secret_reaches_debug_output_or_an_error() {
    let pairing = fixed_pairing();
    let code = pairing.code().replace('-', "");
    let seen = [
        format!("{pairing:?}"),
        format!("{:?}", pairing::read(&code).unwrap()),
        pairing::read(&code[1..]).unwrap_err().to_string(),
        pairing.open_offer(&[1; 40], NOW).unwrap_err().to_string(),
    ]
    .join("\n");
    assert!(!seen.contains(&code[..12]), "{seen}");
    assert!(!seen.contains(&to_hex(
        &std::array::from_fn::<u8, 16, _>(|i| (i * 7) as u8)
    )));
    assert!(seen.contains(pairing.id()));
}

#[test]
fn the_qr_code_holds_the_link_as_modules() {
    let link = fixed_pairing().link(&relay());
    let qr = pairing::qr(&link).unwrap();
    assert!(qr.size >= 21 && qr.size % 4 == 1, "{}", qr.size);
    assert_eq!(qr.modules.len(), qr.size * qr.size);
    assert!(qr.modules.bytes().all(|b| b == b'0' || b == b'1'));
    // The finder pattern's first row, top left.
    assert_eq!(&qr.modules[..7], "1111111");
}

#[test]
fn a_joining_device_s_channel_only_takes_and_confirms() {
    // Port 9 is discard: a request that went out would fail with a network code, not this one.
    let channel = RelayPairing::join(super::client::RelayUrl::parse("http://127.0.0.1:9").unwrap());
    let id = fixed_pairing().id().to_string();
    assert_eq!(channel.open(&id, b"offer"), Err("E_SYNC_PAIRING_ROLE"));
    assert_eq!(channel.poll(&id).err(), Some("E_SYNC_PAIRING_ROLE"));
    assert_eq!(channel.close(&id), Err("E_SYNC_PAIRING_ROLE"));
}

#[test]
fn the_icloud_link_names_icloud_and_the_code() {
    let pairing = fixed_pairing();
    let link = pairing.icloud_link();
    assert_eq!(
        link.as_str(),
        "devot://pair?via=icloud&code=0400E3GN3GHJMC9R7X34TN2VC9MNJTDF"
    );
    let read = pairing::read(&format!(" {} ", link.as_str())).unwrap();
    assert_eq!(read.pairing.id(), pairing.id());
    assert!(read.icloud);
    assert_eq!(read.relay, None);
    let typed = pairing::read(&pairing.code()).unwrap();
    assert!(!typed.icloud, "a code alone names no way");
    let relayed = pairing::read(&pairing.link(&relay())).unwrap();
    assert!(!relayed.icloud);

    let code = pairing.code().replace('-', "");
    for bad in [
        format!("devot://pair?via=icloud&relay=https%3A%2F%2Frelay.example.com&code={code}"),
        format!("devot://pair?via=relay&code={code}"),
        format!("devot://pair?via=icloud&via=icloud&code={code}"),
        "devot://pair?via=icloud".to_string(),
    ] {
        assert_eq!(
            pairing::read(&bad).map(|_| ()),
            Err(SyncError::PairingFormat),
            "{bad}"
        );
    }
}

#[test]
fn an_icloud_offer_names_its_transport_and_never_opens_as_a_relays() {
    let vault = fixed_vault();
    let pairing = fixed_pairing();
    let offer = pairing.seal_icloud_offer(&vault, NOW + TTL_MS).unwrap();
    assert_eq!(offer.len(), 1 + 12 + 58 + 16);
    let joined = pairing::read(&pairing.icloud_link()).unwrap().pairing;
    assert!(same_vault(
        &joined.open_icloud_offer(&offer, NOW).unwrap(),
        &vault
    ));
    assert!(!offer.windows(32).any(|w| w == vault.key()));

    assert_eq!(
        joined.open_offer(&offer, NOW).map(|_| ()),
        Err(SyncError::PairingAuth),
        "a relay's device never reads an iCloud offer"
    );
    let relays = pairing.seal_offer(&vault, NOW + TTL_MS).unwrap();
    assert_eq!(
        joined.open_icloud_offer(&relays, NOW).map(|_| ()),
        Err(SyncError::PairingAuth)
    );
}

#[test]
fn a_forged_swapped_or_expired_icloud_offer_does_not_open() {
    let vault = fixed_vault();
    let pairing = fixed_pairing();
    let offer = pairing.seal_icloud_offer(&vault, NOW + TTL_MS).unwrap();
    let other = Pairing::generate().unwrap();
    let forged = other
        .seal_icloud_offer(&Vault::generate().unwrap(), NOW + TTL_MS)
        .unwrap();
    let swapped = other.seal_icloud_offer(&vault, NOW + TTL_MS).unwrap();
    for sealed in [forged, swapped] {
        assert_eq!(
            pairing.open_icloud_offer(&sealed, NOW).map(|_| ()),
            Err(SyncError::PairingAuth)
        );
    }
    for at in [0, 5, 20, offer.len() - 1] {
        let mut tampered = offer.clone();
        tampered[at] ^= 1;
        assert_eq!(
            pairing.open_icloud_offer(&tampered, NOW).map(|_| ()),
            Err(SyncError::PairingAuth),
            "byte {at}"
        );
    }
    let confirmation = pairing.seal_confirmation("device-1").unwrap();
    assert_eq!(
        pairing.open_icloud_offer(&confirmation, NOW).map(|_| ()),
        Err(SyncError::PairingAuth)
    );
    assert_eq!(
        pairing.open_confirmation(&offer),
        Err(SyncError::PairingAuth)
    );

    let short = pairing.seal_icloud_offer(&vault, NOW).unwrap();
    assert!(pairing.open_icloud_offer(&short, NOW + SKEW_MS).is_ok());
    assert_eq!(
        pairing
            .open_icloud_offer(&short, NOW + SKEW_MS + 1)
            .map(|_| ()),
        Err(SyncError::PairingExpired)
    );
}
