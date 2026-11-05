//! Properties of the pin keys, the trust-on-first-use decision and the checks
//! on pin text from the webview.

use owncord_parse::pins::{
    cert_store_key, decide, extract_host, identity_pin_key, is_valid_cert_fingerprint,
    pin_needs_confirmation, validate_identity_pin_args, web_pki_record, Observed, TofuOutcome,
};
use proptest::prelude::*;
use serde_json::Value;
use std::net::Ipv6Addr;

fn dns_name() -> impl Strategy<Value = String> {
    "[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?(\\.[a-z0-9]{1,8}){0,3}"
}

fn port() -> impl Strategy<Value = u16> {
    prop_oneof![Just(443u16), Just(8443u16), 1u16..=65535]
}

/// A random mix of upper and lower case for `s`.
fn recase(s: &str, mask: u64) -> String {
    s.chars()
        .enumerate()
        .map(|(i, c)| {
            if mask >> (i % 64) & 1 == 1 {
                c.to_ascii_uppercase()
            } else {
                c
            }
        })
        .collect()
}

/// One of three leaf fingerprints, so a stored pin, a recorded web-PKI pin
/// and the leaf just seen often match and every outcome of the decision is
/// reached, not only first use and mismatch.
fn leaf() -> impl Strategy<Value = String> {
    prop::sample::select(vec![
        "AA:01".to_string(),
        "BB:02".to_string(),
        "CC:03".to_string(),
    ])
}

fn fingerprint_of(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// The spellings of one server the client is meant to treat as one: any
/// case, with or without the default port, an IPv6 literal bracketed or not.
#[derive(Debug, Clone)]
enum Server {
    Dns(String, u16),
    V6(Ipv6Addr, u16),
}

fn server() -> impl Strategy<Value = Server> {
    prop_oneof![
        (dns_name(), port()).prop_map(|(h, p)| Server::Dns(h, p)),
        (any::<u128>(), port()).prop_map(|(a, p)| Server::V6(Ipv6Addr::from(a), p)),
    ]
}

fn spellings(server: &Server, mask: u64) -> Vec<String> {
    match server {
        Server::Dns(h, 443) => vec![
            h.clone(),
            format!("{h}:443"),
            recase(h, mask),
            recase(&format!("{h}:443"), mask),
        ],
        Server::Dns(h, p) => vec![format!("{h}:{p}"), recase(&format!("{h}:{p}"), mask)],
        Server::V6(a, 443) => {
            let a = a.to_string();
            vec![
                a.clone(),
                format!("[{a}]"),
                format!("[{a}]:443"),
                recase(&a, mask),
            ]
        }
        Server::V6(a, p) => vec![format!("[{a}]:{p}"), recase(&format!("[{a}]:{p}"), mask)],
    }
}

fn same_server(a: &Server, b: &Server) -> bool {
    match (a, b) {
        (Server::Dns(h1, p1), Server::Dns(h2, p2)) => h1 == h2 && p1 == p2,
        (Server::V6(a1, p1), Server::V6(a2, p2)) => a1 == a2 && p1 == p2,
        _ => false,
    }
}

proptest! {
    #[test]
    fn every_spelling_of_one_server_has_one_pin_key(server in server(), mask in any::<u64>()) {
        let keys: Vec<String> = spellings(&server, mask).iter().map(|s| cert_store_key(s)).collect();
        prop_assert!(keys.windows(2).all(|w| w[0] == w[1]), "{:?}", keys);
    }

    #[test]
    fn two_different_servers_never_share_a_pin_key(a in server(), b in server(), m1 in any::<u64>(), m2 in any::<u64>()) {
        prop_assume!(!same_server(&a, &b));
        for x in spellings(&a, m1) {
            for y in spellings(&b, m2) {
                prop_assert_ne!(cert_store_key(&x), cert_store_key(&y), "{} vs {}", x, y);
            }
        }
    }

    #[test]
    fn a_wss_url_keys_like_its_host(server in server(), path in "(/[a-z0-9]{0,8}){0,3}", mask in any::<u64>()) {
        for spelled in spellings(&server, mask) {
            let bracketed = match &server {
                Server::V6(..) if !spelled.starts_with('[') => format!("[{spelled}]"),
                _ => spelled.clone(),
            };
            prop_assert_eq!(extract_host(&format!("wss://{bracketed}{path}")), cert_store_key(&spelled));
        }
    }

    #[test]
    fn the_pin_key_never_panics_and_is_lower_case(text in "\\PC{0,64}") {
        let key = cert_store_key(&text);
        prop_assert_eq!(key.to_ascii_lowercase(), key.clone());
        let _ = extract_host(&text);
    }

    #[test]
    fn the_trust_decision_follows_the_pin(
        stored in proptest::option::of(leaf()),
        recorded in proptest::option::of(leaf()),
        fingerprint in leaf(),
        web_pki_valid in any::<bool>(),
    ) {
        let current = Observed { fingerprint: fingerprint.clone(), web_pki_valid };
        let outcome = decide(stored.clone(), recorded.as_deref(), &current);
        let expected = match &stored {
            None => TofuOutcome::FirstUse,
            Some(s) if *s == fingerprint => TofuOutcome::Trusted,
            Some(s) if web_pki_valid && recorded.as_deref() == Some(s.as_str()) => TofuOutcome::Renewed { stored: s.clone() },
            Some(s) => TofuOutcome::Mismatch { stored: s.clone() },
        };
        prop_assert_eq!(&outcome, &expected);

        let record = web_pki_record(&outcome, &current, recorded.as_deref());
        if let Some(r) = &record {
            prop_assert!(web_pki_valid);
            prop_assert_eq!(r, &fingerprint);
            let pinned = matches!(outcome, TofuOutcome::Trusted | TofuOutcome::Renewed { .. });
            prop_assert!(pinned);
        }
    }

    #[test]
    fn a_changed_leaf_is_only_accepted_on_a_vouched_public_renewal(
        stored in leaf(),
        fingerprint in leaf(),
        recorded in proptest::option::of(leaf()),
        web_pki_valid in any::<bool>(),
    ) {
        prop_assume!(stored != fingerprint);
        let current = Observed { fingerprint, web_pki_valid };
        let outcome = decide(Some(stored.clone()), recorded.as_deref(), &current);
        if outcome != (TofuOutcome::Mismatch { stored: stored.clone() }) {
            prop_assert!(web_pki_valid && recorded.as_deref() == Some(stored.as_str()));
        }
    }

    #[test]
    fn every_sha256_fingerprint_is_accepted(bytes in prop::array::uniform32(any::<u8>()), lower in any::<bool>()) {
        let fp = fingerprint_of(&bytes);
        let fp = if lower { fp.to_ascii_lowercase() } else { fp };
        prop_assert!(is_valid_cert_fingerprint(&fp));
        prop_assert!(!pin_needs_confirmation(Some(&Value::String(fp.clone())), &fp));
        prop_assert!(pin_needs_confirmation(None, &fp));
    }

    #[test]
    fn a_fingerprint_with_one_wrong_character_is_refused(
        bytes in prop::array::uniform32(any::<u8>()),
        at in 0usize..95,
        with in "[^0-9A-Fa-f:]",
    ) {
        let mut fp: Vec<char> = fingerprint_of(&bytes).chars().collect();
        fp[at] = with.chars().next().unwrap_or('x');
        let fp: String = fp.into_iter().collect();
        prop_assert!(!is_valid_cert_fingerprint(&fp));
    }

    #[test]
    fn the_fingerprint_check_never_panics(text in "\\PC{0,120}") {
        if is_valid_cert_fingerprint(&text) {
            prop_assert_eq!(text.len(), 95);
        }
    }

    #[test]
    fn an_accepted_identity_pin_key_names_one_host_and_user(
        host in "\\PC{0,40}|[a-z0-9.:\\[\\]-]{1,40}",
        user in "\\PC{0,20}|[A-Za-z0-9_-]{1,20}",
        pin in "\\PC{0,20}|[A-Za-z0-9+/=_-]{1,600}",
    ) {
        if validate_identity_pin_args(&host, &user, &pin).is_ok() {
            let key = identity_pin_key(&host, &user);
            prop_assert_eq!(key.rsplit_once(':'), Some((host.as_str(), user.as_str())));
            prop_assert!(pin.len() <= 512 && !pin.is_empty());
            prop_assert!(key.bytes().all(|b| b.is_ascii_graphic()));
        }
    }
}
