//! Request-head parsing and rewriting for the loopback proxies. Every input
//! here is bytes a local client sent, or a host string from the webview.

/// Reject remote_host values that could inject headers or are not plausible
/// host:port strings.
pub fn validate_remote_host(remote_host: &str) -> Result<(), String> {
    if remote_host.is_empty() || remote_host.len() > 260 {
        return Err("remote_host is empty or too long".into());
    }
    if remote_host.contains('\r') || remote_host.contains('\n') || remote_host.contains('\0') {
        return Err("remote_host contains invalid characters".into());
    }
    if !remote_host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
    {
        return Err("remote_host contains unexpected characters".into());
    }
    Ok(())
}

/// Bracket-aware split of a `remote_host` string into (hostname, port).
/// Defaults to port 443 (standard HTTPS) when none is specified.
///
/// A leading `[` consumes up to the matching `]` as the hostname, so a
/// bracketed IPv6 literal parses correctly whether or not it copies an
/// explicit port (`[::1]`, `[::1]:8443`). Without brackets, a single
/// trailing colon is a `host:port` split — but a *bare* (unbracketed) IPv6
/// literal contains more than one colon, and RFC 3986 gives it no way to
/// carry a port without brackets, so that case is returned whole with the
/// default port instead of being mis-split on its last colon.
pub fn split_host_port(remote_host: &str) -> Result<(&str, &str), String> {
    if let Some(rest) = remote_host.strip_prefix('[') {
        let (host, tail) = rest
            .split_once(']')
            .ok_or_else(|| format!("unterminated '[' in remote_host '{remote_host}'"))?;
        let port = tail.strip_prefix(':').unwrap_or("443");
        Ok((host, port))
    } else {
        match remote_host.rsplit_once(':') {
            Some((host, port)) if !host.contains(':') => Ok((host, port)),
            _ => Ok((remote_host, "443")),
        }
    }
}

/// The value of a request header, matched case-insensitively, from the raw
/// request head (`read_request_headers` output, ending in `\r\n\r\n`).
///
/// The request line (first line) is skipped: a request target may contain a
/// colon, so only lines after it are split on the first colon. Surrounding
/// whitespace is trimmed the way an HTTP field value is.
pub fn header_value(raw: &[u8], name: &str) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    for line in text.split("\r\n").skip(1) {
        if line.is_empty() {
            continue;
        }
        let Some((field, value)) = line.split_once(':') else {
            continue;
        };
        if field.trim().eq_ignore_ascii_case(name) {
            return Some(value.trim().to_string());
        }
    }
    None
}

/// The request body length declared by `Content-Length`, if it is a valid
/// non-negative integer. Absent for a chunked or bodyless request.
pub fn content_length(raw: &[u8]) -> Option<u64> {
    header_value(raw, "content-length")?.parse::<u64>().ok()
}

/// Rewrite the header lines of an HTTP request with `rewrite`; every line it
/// returns `None` for is passed through byte-for-byte.
///
/// The plain `split("\r\n")` / re-join round-trips the trailing `\r\n\r\n`
/// terminator exactly, so the request the remote server sees stays well-formed.
pub fn rewrite_headers(request: &str, mut rewrite: impl FnMut(&str) -> Option<String>) -> String {
    let mut modified = String::with_capacity(request.len() + 128);
    for (i, line) in request.split("\r\n").enumerate() {
        if i > 0 {
            modified.push_str("\r\n");
        }
        match rewrite(line) {
            Some(replacement) => modified.push_str(&replacement),
            None => modified.push_str(line),
        }
    }
    modified
}

/// Check that a request's target starts with `/{token}/` and return the
/// request head with that prefix removed. `None` when the request line is
/// malformed, the token is missing or wrong, or a line ends in a lone CR or
/// LF: the rewrites split lines on CRLF only, while a server may also break
/// on a lone LF, so such a head is refused rather than forwarded.
pub fn strip_tunnel_token(head: &[u8], token: &str) -> Option<Vec<u8>> {
    if has_lone_line_break(head) {
        return None;
    }
    let line_end = head.windows(2).position(|w| w == b"\r\n")?;
    let line = &head[..line_end];
    let method_end = line.iter().position(|&b| b == b' ')?;
    let target_start = method_end + 1;
    let target_len = line[target_start..].iter().position(|&b| b == b' ')?;
    let target = &line[target_start..target_start + target_len];

    let rest = target.strip_prefix(b"/")?;
    let slash = rest.iter().position(|&b| b == b'/')?;
    if !constant_time_eq(&rest[..slash], token.as_bytes()) {
        return None;
    }
    let stripped = &rest[slash..];

    let mut out = Vec::with_capacity(head.len());
    out.extend_from_slice(&line[..target_start]);
    out.extend_from_slice(stripped);
    out.extend_from_slice(&line[target_start + target_len..]);
    out.extend_from_slice(&head[line_end..]);
    Some(out)
}

/// Rewrite a request's headers: replace Host with the real remote host and
/// set exactly one `Connection: {connection}`. The one-shot path passes
/// `close`, so the upstream connection ends with the response; the pooled
/// path passes `keep-alive`. Either way the webview sends one request per
/// loopback connection (its response says `Connection: close`), so every
/// request is read and rewritten here, never passed through unread.
/// `raw` must end with the "\r\n\r\n" header terminator.
pub fn rewrite_request_headers(raw: &[u8], remote_host: &str, connection: &str) -> String {
    let mut modified = rewrite_headers(&String::from_utf8_lossy(raw), |line| {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("host:") {
            Some(format!("Host: {remote_host}"))
        } else if lower.starts_with("connection:") {
            Some(format!("Connection: {connection}"))
        } else {
            None
        }
    });
    // `read_request_headers` only returns once it has seen the terminator, so
    // it survives the line split; the `insert_at` below depends on it.
    debug_assert!(modified.ends_with("\r\n\r\n"));
    // If the client never sent a Connection header, inject one.
    if !modified.to_ascii_lowercase().contains("\r\nconnection:") {
        let insert_at = modified.len() - 2; // before final CRLF
        modified.insert_str(insert_at, &format!("Connection: {connection}\r\n"));
    }
    modified
}

/// The upload an in-flight request belongs to: the webview-generated
/// correlation id plus the request's declared body length. Both must be
/// present for the proxy to report progress; every other request takes the
/// plain copy path with no extra work.
pub struct UploadTarget {
    pub id: String,
    pub total: u64,
}

/// Bound on the correlation id the webview sends, so a malformed request head
/// cannot make the proxy hold or re-emit an unbounded value.
pub const MAX_UPLOAD_PROGRESS_ID_LEN: usize = 128;

pub fn upload_progress_target(raw: &[u8]) -> Option<UploadTarget> {
    let id = header_value(raw, "x-upload-id")?;
    if id.is_empty() || id.len() > MAX_UPLOAD_PROGRESS_ID_LEN {
        return None;
    }
    let total = content_length(raw)?;
    if total == 0 {
        return None;
    }
    Some(UploadTarget { id, total })
}

/// Rewrite the `Host` and `Origin` headers of a proxied HTTP request so the
/// remote server's WebSocket origin check accepts a connection that the
/// LiveKit SDK opened against `127.0.0.1`.
///
/// Every other line is passed through byte-for-byte, including the request
/// line and the trailing blank line that terminates the header block.
pub fn rewrite_proxy_headers(request: &str, remote_host: &str) -> String {
    rewrite_headers(request, |line| {
        let lower = line.to_lowercase();
        if lower.starts_with("host:") {
            Some(format!("Host: {remote_host}"))
        } else if lower.starts_with("origin:") {
            Some(format!("Origin: https://{remote_host}"))
        } else {
            None
        }
    })
}

/// Give a request that is not a WebSocket upgrade `Connection: close`, so the
/// server ends the connection after its response and every request on the
/// loopback side comes through the tunnel's own path check. An upgrade request
/// is returned unchanged.
pub fn close_unless_upgrade(request: &str) -> String {
    let head = request.strip_suffix("\r\n\r\n").unwrap_or(request);
    let lines: Vec<&str> = head.split("\r\n").collect();
    if lines
        .iter()
        .skip(1)
        .any(|l| l.to_ascii_lowercase().starts_with("upgrade:"))
    {
        return request.to_string();
    }
    let mut out = String::with_capacity(request.len() + 20);
    for (i, line) in lines.iter().enumerate() {
        if i > 0 && line.to_ascii_lowercase().starts_with("connection:") {
            continue;
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str("Connection: close\r\n\r\n");
    out
}

/// Move an `Authorization: Bearer` token into the `access_token` query
/// parameter and drop the header.
///
/// The LiveKit Rust SDK (the Linux client's native voice) sends its join token
/// only as a bearer header, and older servers drop every header
/// when re-dialling LiveKit, so the join fails with 401. The query string
/// survives on every server version — it is how the JS SDK sends the token —
/// so the tunnel rewrites the request into that shape. A request with no bearer
/// header passes through unchanged.
pub fn move_bearer_to_query(request: &str) -> String {
    let mut lines: Vec<&str> = request.split("\r\n").collect();
    let bearer = lines.iter().enumerate().skip(1).find_map(|(i, line)| {
        let (name, value) = line.split_once(':')?;
        if !name.trim().eq_ignore_ascii_case("authorization") {
            return None;
        }
        let value = value.trim();
        let (scheme, token) = value.split_once(' ')?;
        let token = token.trim();
        (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then_some((i, token))
    });
    let Some((header_idx, token)) = bearer else {
        return request.to_string();
    };
    let mut parts = lines[0].splitn(3, ' ');
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return request.to_string();
    };
    let encoded: String = url::form_urlencoded::byte_serialize(token.as_bytes()).collect();
    let sep = if target.contains('?') { '&' } else { '?' };
    let request_line = format!("{method} {target}{sep}access_token={encoded} {version}");
    lines[0] = &request_line;
    lines.remove(header_idx);
    lines.join("\r\n")
}

/// Decide whether an already-running proxy can serve a new start request:
/// only when both the remote host AND the TOFU-pinned fingerprint are
/// unchanged. The listener bakes its fingerprint in at spawn, so after the
/// user accepts a rotated cert (which rewrites the store), reusing the old
/// listener would fail every TLS handshake against the stale pin until
/// logout — the caller must tear down and restart instead.
pub fn can_reuse_proxy(
    running_host: &str,
    running_fingerprint: &str,
    requested_host: &str,
    stored_fingerprint: &str,
) -> bool {
    running_host == requested_host && running_fingerprint == stored_fingerprint
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whether `head` holds a CR not followed by LF, or an LF not preceded by CR.
fn has_lone_line_break(head: &[u8]) -> bool {
    head.iter().enumerate().any(|(i, &b)| match b {
        b'\r' => head.get(i + 1) != Some(&b'\n'),
        b'\n' => i == 0 || head[i - 1] != b'\r',
        _ => false,
    })
}
