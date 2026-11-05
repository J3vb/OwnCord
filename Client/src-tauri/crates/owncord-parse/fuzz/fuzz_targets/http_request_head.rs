//! A request head as the HTTP tunnel reads it from the loopback side: the
//! token check, then the header rewrite and the upload-progress lookup.
#![no_main]

use libfuzzer_sys::fuzz_target;
use owncord_parse::proxy::{
    header_value, rewrite_request_headers, strip_tunnel_token, upload_progress_target,
};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fuzz_target!(|data: &[u8]| {
    check(data);
    // Most random heads fail the token check; also feed one that carries the
    // token, so the rewrite behind it is reached.
    let mut with_token = format!("GET /{TOKEN}/").into_bytes();
    with_token.extend_from_slice(data);
    check(&with_token);
});

fn check(data: &[u8]) {
    let mut head = data.to_vec();
    if !head.ends_with(b"\r\n\r\n") {
        head.extend_from_slice(b"\r\n\r\n");
    }
    let _ = header_value(&head, "content-length");
    let _ = upload_progress_target(&head);
    let Some(stripped) = strip_tunnel_token(&head, TOKEN) else {
        return;
    };
    for connection in ["close", "keep-alive"] {
        let out = rewrite_request_headers(&stripped, "example.com:8443", connection);
        assert!(out.ends_with("\r\n\r\n"));
        for line in out.split("\r\n").skip(1) {
            let lower = line.to_ascii_lowercase();
            assert!(!line.contains('\n') && !line.contains('\r'));
            if lower.starts_with("host:") {
                assert_eq!(line, "Host: example.com:8443");
            }
            if lower.starts_with("connection:") {
                assert_eq!(line, format!("Connection: {connection}"));
            }
        }
    }
}
