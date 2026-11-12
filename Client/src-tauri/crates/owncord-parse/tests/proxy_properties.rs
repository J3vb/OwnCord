//! Properties of the loopback proxies' request-head handling, over generated
//! heads and hosts.

use owncord_parse::proxy::{
    close_unless_upgrade, content_length, header_value, move_bearer_to_query,
    rewrite_proxy_headers, rewrite_request_headers, split_host_port, strip_tunnel_token,
    upload_progress_target, validate_remote_host, MAX_UPLOAD_PROGRESS_ID_LEN,
};
use proptest::prelude::*;

/// A host the proxies accept: what `validate_remote_host` lets through.
fn valid_host() -> impl Strategy<Value = String> {
    prop_oneof![
        "[a-z0-9][a-z0-9.-]{0,30}(:[0-9]{1,5})?",
        "\\[[0-9a-f:]{2,39}\\](:[0-9]{1,5})?",
    ]
}

/// One header line as a client might send it: any non-empty text without CR
/// or LF (an empty line ends the head), sometimes a Host, Connection, Origin
/// or Authorization line.
fn header_line() -> impl Strategy<Value = String> {
    prop_oneof![
        "[ -~]{1,40}",
        "[Hh][Oo][Ss][Tt]: ?[ -~]{0,20}",
        "[Cc]onnection: ?[ -~]{0,20}",
        "[Oo]rigin: ?[ -~]{0,20}",
        "[Aa]uthorization: ?[Bb]earer [!-~]{0,30}",
        "[Uu]pgrade: websocket",
        "\\PC{1,20}",
    ]
}

/// A request head ending in the `\r\n\r\n` terminator, as
/// `read_request_headers` hands it on.
fn request_head() -> impl Strategy<Value = String> {
    (
        "(GET|POST|PUT|HEAD|OPTIONS) /[!-~]{0,30} HTTP/1\\.1",
        prop::collection::vec(header_line(), 0..8),
    )
        .prop_map(|(line, headers)| {
            let mut head = line;
            for h in headers {
                head.push_str("\r\n");
                head.push_str(&h);
            }
            head.push_str("\r\n\r\n");
            head
        })
}

/// The header lines of a head: everything between the request line and the
/// blank line that ends it.
fn header_lines(head: &str) -> Vec<&str> {
    let body = head.strip_suffix("\r\n\r\n").unwrap_or(head);
    body.split("\r\n").skip(1).collect()
}

fn starts_with_ci(line: &str, prefix: &str) -> bool {
    line.len() >= prefix.len()
        && line.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

proptest! {
    #[test]
    fn an_accepted_host_cannot_carry_a_line_break(host in "\\PC{0,64}|[ -~\r\n\0]{0,64}") {
        if validate_remote_host(&host).is_ok() {
            prop_assert!(!host.is_empty() && host.len() <= 260);
            prop_assert!(host.bytes().all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b)));
        }
    }

    #[test]
    fn generated_hosts_are_accepted(host in valid_host()) {
        prop_assert!(validate_remote_host(&host).is_ok());
    }

    #[test]
    fn split_host_port_never_panics_and_keeps_a_plain_host_whole(host in "[a-z0-9.-]{1,30}", port in "[0-9]{1,5}") {
        let joined = format!("{host}:{port}");
        prop_assert_eq!(split_host_port(&joined), Ok((host.as_str(), port.as_str())));
        prop_assert_eq!(split_host_port(&host), Ok((host.as_str(), "443")));
    }

    #[test]
    fn split_host_port_accepts_any_text_without_panicking(text in "\\PC{0,64}") {
        let _ = split_host_port(&text);
    }

    #[test]
    fn header_lookups_never_panic_on_arbitrary_bytes(raw in prop::collection::vec(any::<u8>(), 0..512)) {
        let _ = header_value(&raw, "x-upload-id");
        if let Some(n) = content_length(&raw) {
            let value = header_value(&raw, "content-length");
            prop_assert_eq!(value.as_deref().map(str::parse::<u64>), Some(Ok(n)));
        }
        if let Some(target) = upload_progress_target(&raw) {
            prop_assert!(!target.id.is_empty() && target.id.len() <= MAX_UPLOAD_PROGRESS_ID_LEN);
            prop_assert!(target.total > 0);
        }
    }

    #[test]
    fn the_http_rewrite_owns_every_host_and_connection_line(
        head in request_head(),
        host in valid_host(),
        keep_alive in any::<bool>(),
    ) {
        let connection = if keep_alive { "keep-alive" } else { "close" };
        let out = rewrite_request_headers(head.as_bytes(), &host, connection);
        prop_assert!(out.ends_with("\r\n\r\n"));
        prop_assert!(!out.ends_with("\r\n\r\n\r\n"));
        prop_assert_eq!(out.split("\r\n").next(), head.split("\r\n").next());
        let lines = header_lines(&out);
        let mut connections = 0;
        for line in &lines {
            if starts_with_ci(line, "host:") {
                prop_assert_eq!(*line, format!("Host: {host}"));
            }
            if starts_with_ci(line, "connection:") {
                prop_assert_eq!(*line, format!("Connection: {connection}"));
                connections += 1;
            }
        }
        prop_assert!(connections >= 1);
        prop_assert!(lines.iter().all(|l| !l.contains('\n') && !l.contains('\r')));
    }

    #[test]
    fn the_http_rewrite_never_panics_on_any_terminated_head(
        raw in prop::collection::vec(any::<u8>(), 0..512),
        host in valid_host(),
    ) {
        let mut head = raw;
        head.extend_from_slice(b"\r\n\r\n");
        let out = rewrite_request_headers(&head, &host, "close");
        prop_assert!(out.ends_with("\r\n\r\n"));
    }

    #[test]
    fn the_livekit_rewrite_owns_every_host_and_origin_line(head in request_head(), host in valid_host()) {
        let out = rewrite_proxy_headers(&head, &host);
        prop_assert_eq!(out.split("\r\n").count(), head.split("\r\n").count());
        prop_assert!(out.ends_with("\r\n\r\n"));
        for line in header_lines(&out) {
            if starts_with_ci(line, "host:") {
                prop_assert_eq!(line, format!("Host: {host}"));
            }
            if starts_with_ci(line, "origin:") {
                prop_assert_eq!(line, format!("Origin: https://{host}"));
            }
        }
    }

    #[test]
    fn a_plain_request_is_closed_and_an_upgrade_left_alone(head in request_head()) {
        let out = close_unless_upgrade(&head);
        let upgrade = header_lines(&head).iter().any(|l| starts_with_ci(l, "upgrade:"));
        if upgrade {
            prop_assert_eq!(out, head);
        } else {
            prop_assert!(out.ends_with("Connection: close\r\n\r\n"));
            let connections = header_lines(&out).iter().filter(|l| starts_with_ci(l, "connection:")).count();
            prop_assert_eq!(connections, 1);
        }
    }

    #[test]
    fn a_bearer_token_moves_into_the_query_and_its_header_goes(
        path in "/[a-z0-9/]{0,20}(\\?[a-z0-9=&]{0,10})?",
        token in "[!-~]{1,40}",
        before in prop::collection::vec("[A-Za-z-]{1,10}: [ -~]{0,10}", 0..3),
    ) {
        let mut head = format!("GET {path} HTTP/1.1");
        for h in &before {
            head.push_str("\r\n");
            head.push_str(h);
        }
        head.push_str(&format!("\r\nAuthorization: Bearer {token}\r\n\r\n"));
        let has_auth = before.iter().any(|h| starts_with_ci(h, "authorization:"));
        prop_assume!(!has_auth);

        let out = move_bearer_to_query(&head);
        let encoded: String = url::form_urlencoded::byte_serialize(token.as_bytes()).collect();
        let sep = if path.contains('?') { '&' } else { '?' };
        let expected_line = format!("GET {path}{sep}access_token={encoded} HTTP/1.1");
        prop_assert_eq!(out.split("\r\n").next(), Some(expected_line.as_str()));
        prop_assert!(!header_lines(&out).iter().any(|l| starts_with_ci(l, "authorization:")));
        prop_assert_eq!(out.split("\r\n").count() + 1, head.split("\r\n").count());
    }

    #[test]
    fn the_bearer_move_never_panics_and_only_ever_drops_one_line(head in request_head()) {
        let out = move_bearer_to_query(&head);
        let (a, b) = (out.split("\r\n").count(), head.split("\r\n").count());
        prop_assert!(a == b || a + 1 == b);
    }

    #[test]
    fn only_the_exact_tunnel_token_opens_the_tunnel(
        token in "[0-9a-f]{64}",
        other in "[0-9a-f]{64}",
        path in "/[!-~]{0,30}",
        headers in "(\r\n[ -~]{1,20}){0,3}",
    ) {
        let head = format!("GET /{token}{path} HTTP/1.1{headers}\r\n\r\n");
        let stripped = strip_tunnel_token(head.as_bytes(), &token);
        prop_assert_eq!(stripped, Some(format!("GET {path} HTTP/1.1{headers}\r\n\r\n").into_bytes()));
        if other != token {
            prop_assert_eq!(strip_tunnel_token(head.as_bytes(), &other), None);
        }
    }

    #[test]
    fn the_tunnel_check_never_panics_on_arbitrary_bytes(
        raw in prop::collection::vec(any::<u8>(), 0..256),
        token in "[0-9a-f]{64}",
    ) {
        if let Some(out) = strip_tunnel_token(&raw, &token) {
            prop_assert!(out.len() + token.len() < raw.len());
        }
    }

    #[test]
    fn a_head_with_a_lone_line_break_never_passes_the_tunnel(
        token in "[0-9a-f]{64}",
        before in "[ -~]{0,20}",
        after in "[ -~]{0,20}",
        lone_cr in any::<bool>(),
    ) {
        let brk = if lone_cr { "\r" } else { "\n" };
        let head = format!("GET /{token}/api HTTP/1.1\r\nX-A: {before}{brk}Host: {after}\r\n\r\n");
        prop_assert_eq!(strip_tunnel_token(head.as_bytes(), &token), None);
    }
}
