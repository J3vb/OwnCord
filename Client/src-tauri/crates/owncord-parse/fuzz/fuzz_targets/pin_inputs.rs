//! Host, fingerprint and identity-pin text as the webview hands it to the
//! pin commands, and a store file as it may be found on disk.
#![no_main]

use libfuzzer_sys::fuzz_target;
use owncord_parse::pins::{
    cert_store_key, extract_host, identity_pin_key, is_valid_cert_fingerprint,
    validate_identity_pin_args,
};
use owncord_parse::proxy::{split_host_port, validate_remote_host};
use owncord_parse::store::parse_map;

fuzz_target!(|data: &[u8]| {
    let _ = parse_map(data);
    let text = String::from_utf8_lossy(data);
    let key = cert_store_key(&text);
    assert_eq!(key.to_ascii_lowercase(), key);
    let _ = extract_host(&text);
    let _ = is_valid_cert_fingerprint(&text);
    if validate_remote_host(&text).is_ok() {
        assert!(!text.contains(['\r', '\n', '\0', ' ']));
        let _ = split_host_port(&text);
    }
    let mut parts = text.splitn(3, '\u{0}');
    let (host, user, pin) = (
        parts.next().unwrap_or(""),
        parts.next().unwrap_or(""),
        parts.next().unwrap_or(""),
    );
    if validate_identity_pin_args(host, user, pin).is_ok() {
        assert_eq!(
            identity_pin_key(host, user).rsplit_once(':'),
            Some((host, user))
        );
    }
});
