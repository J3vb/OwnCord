//! A request head as the LiveKit tunnel reads it: the token check, then the
//! Host/Origin rewrite, `Connection: close` for a plain request, and the
//! bearer token moved into the query.
#![no_main]

use libfuzzer_sys::fuzz_target;
use owncord_parse::proxy::{
    close_unless_upgrade, move_bearer_to_query, rewrite_proxy_headers, strip_tunnel_token,
};

const TOKEN: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

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
    let Some(stripped) = strip_tunnel_token(&head, TOKEN) else {
        return;
    };
    let text = String::from_utf8_lossy(&stripped);
    let rewritten = rewrite_proxy_headers(&text, "voice.example.com");
    let closed = close_unless_upgrade(&rewritten);
    let out = move_bearer_to_query(&closed);
    let lines = out.split("\r\n").count();
    let before = closed.split("\r\n").count();
    assert!(lines == before || lines + 1 == before);
    for line in out.split("\r\n").skip(1) {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("host:") {
            assert_eq!(line, "Host: voice.example.com");
        }
        if lower.starts_with("origin:") {
            assert_eq!(line, "Origin: https://voice.example.com");
        }
    }
}
