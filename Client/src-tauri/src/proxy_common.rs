//! Helpers shared by the two loopback TLS proxies (`http_proxy`, `livekit_proxy`).
//!
//! Each proxy keeps only what is genuinely different — its state type, its
//! header-rewrite policy (REST wants `Connection: close`; the LiveKit signal
//! request wants `Origin` rewritten), and its verifier (TOFU capture vs
//! pinned) — and pulls the rest from here. The long-lived data phase of the
//! LiveKit tunnel deliberately keeps a plain `io::copy_bidirectional` (a WS
//! connection may idle for hours), while the request/response HTTP tunnel
//! wraps the same copy in [`copy_with_deadline`].

use log::{debug, error, info, warn};
use rustls::pki_types::ServerName;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
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

/// The value of a request header, matched case-insensitively, from the raw
/// request head (`read_request_headers` output, ending in `\r\n\r\n`).
///
/// The request line (first line) is skipped: a request target may contain a
/// colon, so only lines after it are split on the first colon. Surrounding
/// whitespace is trimmed the way an HTTP field value is.
pub(crate) fn header_value(raw: &[u8], name: &str) -> Option<String> {
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
pub(crate) fn content_length(raw: &[u8]) -> Option<u64> {
    header_value(raw, "content-length")?.parse::<u64>().ok()
}

/// Wraps a stream so every byte *read* from it is added to `read_bytes`;
/// writes pass through untouched. `http_proxy` uses this to report upload
/// progress while `copy_bidirectional` moves the request body, without
/// disturbing the full-duplex copy or its deadline.
pub(crate) struct CountingStream<A> {
    inner: A,
    read_bytes: Arc<AtomicU64>,
}

impl<A> CountingStream<A> {
    pub(crate) fn new(inner: A, read_bytes: Arc<AtomicU64>) -> Self {
        Self { inner, read_bytes }
    }
}

impl<A: AsyncRead + Unpin> AsyncRead for CountingStream<A> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let result = Pin::new(&mut this.inner).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Ok(()))) {
            let read = buf.filled().len().saturating_sub(before) as u64;
            if read > 0 {
                this.read_bytes.fetch_add(read, Ordering::Relaxed);
            }
        }
        result
    }
}

impl<A: AsyncWrite + Unpin> AsyncWrite for CountingStream<A> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// Maximum consecutive accept errors before [`run_accept_loop`] exits.
pub(crate) const MAX_CONSECUTIVE_ACCEPT_ERRORS: u32 = 5;

/// Watch a proxy loop so a panic is logged instead of vanishing silently
/// (which would leave JS with a stale cached port and no error).
pub(crate) fn spawn_watched(tag: &'static str, handle: JoinHandle<()>) {
    tokio::spawn(async move {
        match handle.await {
            Ok(()) => info!("[{tag}] proxy loop exited"),
            Err(e) if e.is_panic() => error!("[{tag}] proxy loop panicked: {e:?}"),
            Err(e) => warn!("[{tag}] proxy loop join error: {e:?}"),
        }
    });
}

/// Accept loop shared by both proxies: hand each connection to `on_conn` and,
/// once `MAX_CONSECUTIVE_ACCEPT_ERRORS` is hit, run `on_dead` before exiting.
///
/// `on_dead` must run HERE, while `listener` is still held, and not by the
/// caller after this returns: the listener still owns the port, so no newer
/// tunnel can have been handed the same number and the port guard cannot
/// misfire.
pub(crate) async fn run_accept_loop<C, Fut, D, DFut>(
    listener: TcpListener,
    mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
    tag: &'static str,
    mut on_conn: C,
    on_dead: D,
) where
    C: FnMut(TcpStream) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
    D: FnOnce() -> DFut,
    DFut: std::future::Future<Output = ()>,
{
    let mut consecutive_errors: u32 = 0;
    let mut on_dead = Some(on_dead);

    loop {
        tokio::select! {
            result = listener.accept() => {
                match result {
                    Ok((stream, addr)) => {
                        consecutive_errors = 0;
                        debug!("[{tag}] accepted connection from {}", addr);
                        tokio::spawn(on_conn(stream));
                    }
                    Err(e) => {
                        consecutive_errors += 1;
                        error!(
                            "[{tag}] accept error ({}/{}): {}",
                            consecutive_errors, MAX_CONSECUTIVE_ACCEPT_ERRORS, e
                        );
                        if consecutive_errors >= MAX_CONSECUTIVE_ACCEPT_ERRORS {
                            error!(
                                "[{tag}] {} consecutive accept errors, stopping proxy loop",
                                MAX_CONSECUTIVE_ACCEPT_ERRORS
                            );
                            if let Some(on_dead) = on_dead.take() {
                                on_dead().await;
                            }
                            break;
                        }
                    }
                }
            }
            _ = &mut shutdown_rx => break,
        }
    }
}

/// Rewrite the header lines of an HTTP request with `rewrite`; every line it
/// returns `None` for is passed through byte-for-byte.
///
/// The plain `split("\r\n")` / re-join round-trips the trailing `\r\n\r\n`
/// terminator exactly, so the request the remote server sees stays well-formed.
pub(crate) fn rewrite_headers(
    request: &str,
    mut rewrite: impl FnMut(&str) -> Option<String>,
) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

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

    #[test]
    fn header_value_is_case_insensitive_and_trimmed() {
        let raw = b"POST /api/v1/uploads HTTP/1.1\r\nHost: x\r\nX-Upload-Id: abc-123  \r\nContent-Length: 42\r\n\r\n";
        assert_eq!(header_value(raw, "x-upload-id").as_deref(), Some("abc-123"));
        assert_eq!(header_value(raw, "X-UPLOAD-ID").as_deref(), Some("abc-123"));
        assert_eq!(header_value(raw, "missing"), None);
    }

    #[test]
    fn header_value_ignores_the_request_line() {
        // A request-target that itself contains a colon must not be read as a
        // header pair.
        let raw = b"GET /x:y HTTP/1.1\r\nHost: h\r\n\r\n";
        assert_eq!(header_value(raw, "GET /x"), None);
    }

    #[test]
    fn content_length_parses_and_rejects_garbage() {
        assert_eq!(
            content_length(b"POST / HTTP/1.1\r\nContent-Length: 1024\r\n\r\n"),
            Some(1024)
        );
        assert_eq!(
            content_length(b"POST / HTTP/1.1\r\nContent-Length: many\r\n\r\n"),
            None
        );
        assert_eq!(content_length(b"GET / HTTP/1.1\r\n\r\n"), None);
    }

    // The upload progress counter: every byte read from the wrapped stream is
    // added to the shared total, so the proxy can emit progress while
    // `copy_bidirectional` moves the request body.
    #[tokio::test]
    async fn counting_stream_totals_bytes_read() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let counter = Arc::new(AtomicU64::new(0));
        let mut counted = CountingStream::new(reader, Arc::clone(&counter));

        writer.write_all(b"hello world").await.expect("write");
        writer.shutdown().await.expect("shutdown");

        let copied = io::copy(&mut counted, &mut io::sink()).await.expect("copy");
        assert_eq!(copied, 11);
        assert_eq!(counter.load(Ordering::Relaxed), 11);
    }

    #[tokio::test]
    async fn counting_stream_passes_writes_through() {
        let (writer, mut reader) = tokio::io::duplex(64);
        let counter = Arc::new(AtomicU64::new(0));
        let mut counted = CountingStream::new(writer, Arc::clone(&counter));

        counted.write_all(b"payload").await.expect("write");
        counted.shutdown().await.expect("shutdown");

        let mut buf = Vec::new();
        reader.read_to_end(&mut buf).await.expect("read");
        assert_eq!(buf, b"payload");
        assert_eq!(counter.load(Ordering::Relaxed), 0, "writes are not counted");
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
