//! Helpers shared by the two loopback TLS proxies (`http_proxy`, `livekit_proxy`).
//!
//! Each proxy keeps only what is genuinely different — its state type, its
//! header rewriting (REST wants `Connection: close`; the LiveKit signal
//! request wants `Origin` rewritten), and its verifier (TOFU capture vs
//! pinned) — and pulls the rest from here. The long-lived data phase of the
//! LiveKit tunnel deliberately keeps a plain `io::copy_bidirectional` (a WS
//! connection may idle for hours), while the request/response HTTP tunnel
//! wraps the same copy in [`copy_with_deadline`].

use rustls::pki_types::ServerName;
use std::net::IpAddr;
use std::time::Duration;
use tokio::io::{self, AsyncRead, AsyncReadExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

/// Reject remote_host values that could inject headers or are not plausible
/// host:port strings.
pub(crate) fn validate_remote_host(remote_host: &str) -> Result<(), String> {
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
pub(crate) fn split_host_port(remote_host: &str) -> Result<(&str, &str), String> {
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

/// Derive the TLS `ServerName` (SNI) and the TCP dial target from a
/// `remote_host` string.
pub(crate) fn resolve_remote_target(
    remote_host: &str,
) -> Result<(ServerName<'static>, String), String> {
    let (hostname, port) = split_host_port(remote_host)?;
    let server_name = if let Ok(ip) = hostname.parse::<IpAddr>() {
        ServerName::IpAddress(ip.into())
    } else {
        ServerName::try_from(hostname.to_string())
            .map_err(|e| format!("invalid server name '{hostname}': {e}"))?
    };

    let dial_target = if hostname.contains(':') {
        format!("[{hostname}]:{port}")
    } else {
        format!("{hostname}:{port}")
    };
    Ok((server_name, dial_target))
}

/// Dial `dial_target` and complete the TLS handshake, bounding each step by
/// `limit`.
///
/// Both steps must be bounded. A peer that accepts the TCP connection and then
/// never answers the ClientHello blocks the handshake forever, and the calling
/// task holds `local` without polling it — so the SDK closing its side never
/// cancels it. Those tasks and their sockets accumulate on every SDK retry and
/// survive the proxy's stop command, whose shutdown oneshot only stops the
/// accept loop; the per-connection tasks are detached.
pub(crate) async fn connect_tls(
    connector: &tokio_rustls::TlsConnector,
    server_name: ServerName<'static>,
    dial_target: &str,
    limit: Duration,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, Box<dyn std::error::Error + Send + Sync>> {
    let tcp = timeout(limit, TcpStream::connect(dial_target))
        .await
        .map_err(|_| Box::<dyn std::error::Error + Send + Sync>::from("TCP connect timed out"))??;
    let tls = timeout(limit, connector.connect(server_name, tcp))
        .await
        .map_err(|_| {
            Box::<dyn std::error::Error + Send + Sync>::from("TLS handshake timed out")
        })??;
    Ok(tls)
}

/// Read the HTTP request headers from the loopback side, up to the `\r\n\r\n`
/// terminator, under a 10s guard with a 16 KiB cap. Shared byte-identical by
/// both proxies (BUG-151 / stalled-client guard).
pub(crate) async fn read_request_headers(
    local: &mut (impl AsyncRead + Unpin),
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let mut buf = Vec::with_capacity(4096);
    timeout(Duration::from_secs(10), async {
        let mut trailer = [0u8; 4];
        loop {
            let mut byte = [0u8; 1];
            local.read_exact(&mut byte).await?;
            buf.push(byte[0]);
            trailer[0] = trailer[1];
            trailer[1] = trailer[2];
            trailer[2] = trailer[3];
            trailer[3] = byte[0];
            if trailer == *b"\r\n\r\n" {
                break;
            }
            if buf.len() > 16_384 {
                return Err(Box::<dyn std::error::Error + Send + Sync>::from(
                    "HTTP request headers too large",
                ));
            }
        }
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    })
    .await
    .map_err(|_| {
        Box::<dyn std::error::Error + Send + Sync>::from("request header read timed out")
    })??;
    Ok(buf)
}

/// Run io::copy_bidirectional under a deadline.
pub(crate) async fn copy_with_deadline<A, B>(
    local: &mut A,
    remote: &mut B,
    dur: Duration,
) -> io::Result<(u64, u64)>
where
    A: io::AsyncRead + io::AsyncWrite + Unpin + ?Sized,
    B: io::AsyncRead + io::AsyncWrite + Unpin + ?Sized,
{
    match timeout(dur, io::copy_bidirectional(local, remote)).await {
        Ok(result) => result,
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "data phase timed out",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_crlf_and_null() {
        assert!(validate_remote_host("evil\r\nhost").is_err());
        assert!(validate_remote_host("evil\0host").is_err());
    }

    #[test]
    fn validate_rejects_empty_and_odd_chars() {
        assert!(validate_remote_host("").is_err());
        assert!(validate_remote_host("host name").is_err());
        assert!(validate_remote_host("host/path").is_err());
    }

    #[test]
    fn validate_accepts_typical_hosts() {
        assert!(validate_remote_host("example.com:8443").is_ok());
        assert!(validate_remote_host("192.168.1.10:8443").is_ok());
        assert!(validate_remote_host("[::1]:8443").is_ok());
    }

    // OC-0021: IPv6 hosts that are not in the exact `[addr]:port` shape must
    // still resolve to a valid ServerName and a dialable host:port target.

    #[test]
    fn resolve_remote_target_handles_bracketed_ipv6_without_port() {
        let (server_name, dial_target) = resolve_remote_target("[2001:db8::1]")
            .expect("bracketed IPv6 without a port must parse");
        assert!(matches!(server_name, ServerName::IpAddress(_)));
        assert_eq!(dial_target, "[2001:db8::1]:443");
    }

    #[test]
    fn resolve_remote_target_handles_bare_ipv6_without_port() {
        let (server_name, dial_target) =
            resolve_remote_target("2001:db8::1").expect("bare IPv6 without a port must parse");
        assert!(matches!(server_name, ServerName::IpAddress(_)));
        assert_eq!(dial_target, "[2001:db8::1]:443");
    }

    #[test]
    fn resolve_remote_target_still_handles_bracketed_ipv6_with_port() {
        let (server_name, dial_target) = resolve_remote_target("[2001:db8::1]:8443")
            .expect("bracketed IPv6 with a port must parse");
        assert!(matches!(server_name, ServerName::IpAddress(_)));
        assert_eq!(dial_target, "[2001:db8::1]:8443");
    }

    #[test]
    fn resolve_remote_target_still_handles_plain_hostname_and_port() {
        let (server_name, dial_target) =
            resolve_remote_target("example.com:8443").expect("hostname:port must parse");
        assert!(matches!(server_name, ServerName::DnsName(_)));
        assert_eq!(dial_target, "example.com:8443");
    }

    // OC-0218: the data phase of a tunneled request must not be able to hang
    // forever. Simulate the stall with two in-memory duplex pairs where
    // neither peer ever writes or disconnects, so raw `io::copy_bidirectional`
    // would block forever.
    #[tokio::test]
    async fn copy_with_deadline_reclaims_a_stalled_connection() {
        let (mut local_near, _local_far) = tokio::io::duplex(64);
        let (mut remote_near, _remote_far) = tokio::io::duplex(64);

        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            copy_with_deadline(&mut local_near, &mut remote_near, Duration::from_millis(50)),
        )
        .await
        .expect(
            "copy_with_deadline must resolve on its own deadline; the data phase must not hang \
             indefinitely on a stalled remote (OC-0218)",
        );

        let err = outcome.expect_err("a stalled remote must surface as a timeout error, not Ok");
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }
}
