//! Helpers shared by the two loopback TLS proxies (`http_proxy`, `livekit_proxy`).
//!
//! Each proxy keeps only what is genuinely different — its state type, its
//! header-rewrite policy (REST wants `Connection: close`; the LiveKit signal
//! request wants `Origin` rewritten), and its verifier (TOFU capture vs
//! pinned) — and pulls the rest from here. The long-lived data phase of the
//! LiveKit tunnel deliberately keeps a plain `io::copy_bidirectional` (a WS
//! connection may idle for hours), while the request/response HTTP tunnel
//! wraps the same copy in [`copy_with_deadline`], which cuts it only after a
//! stretch with no bytes moving.

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

#[cfg(test)]
use owncord_parse::proxy::content_length;
pub(crate) use owncord_parse::proxy::{
    header_value, split_host_port, strip_tunnel_token, validate_remote_host,
};

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
/// task holds `local` without polling it, so the SDK closing its side never
/// cancels it.
pub(crate) async fn connect_tls(
    connector: &tokio_rustls::TlsConnector,
    server_name: ServerName<'static>,
    dial_target: &str,
    limit: Duration,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, Box<dyn std::error::Error + Send + Sync>> {
    let tcp = dial_tcp(dial_target, limit).await?;
    connect_tls_over(connector, server_name, tcp, limit).await
}

/// Dial the upstream TCP connection, bounded by `limit`.
///
/// Split from [`connect_tls`] so a caller that must configure the socket
/// before the handshake (the REST tunnel sets TCP_NODELAY) can dial, adjust,
/// then hand the stream to [`connect_tls_over`]. The LiveKit tunnel keeps
/// calling [`connect_tls`] and is unaffected.
pub(crate) async fn dial_tcp(
    dial_target: &str,
    limit: Duration,
) -> Result<TcpStream, Box<dyn std::error::Error + Send + Sync>> {
    let tcp = timeout(limit, TcpStream::connect(dial_target))
        .await
        .map_err(|_| Box::<dyn std::error::Error + Send + Sync>::from("TCP connect timed out"))??;
    Ok(tcp)
}

/// Complete the TLS handshake over an already-dialed `tcp`, bounded by
/// `limit` (the same mandatory bound [`connect_tls`] documents).
pub(crate) async fn connect_tls_over(
    connector: &tokio_rustls::TlsConnector,
    server_name: ServerName<'static>,
    tcp: TcpStream,
    limit: Duration,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, Box<dyn std::error::Error + Send + Sync>> {
    let tls = timeout(limit, connector.connect(server_name, tcp))
        .await
        .map_err(|_| {
            Box::<dyn std::error::Error + Send + Sync>::from("TLS handshake timed out")
        })??;
    Ok(tls)
}

/// Read the HTTP request headers from the loopback side, up to the `\r\n\r\n`
/// terminator, under a 10s guard with a 16 KiB cap. Shared byte-identical by
/// both proxies (the stalled-client guard).
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

/// When bytes last moved on a tunneled connection, for an idle deadline that a
/// slow but progressing transfer never reaches.
pub(crate) struct Activity {
    start: tokio::time::Instant,
    last_ms: AtomicU64,
}

impl Activity {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            start: tokio::time::Instant::now(),
            last_ms: AtomicU64::new(0),
        })
    }

    fn mark(&self) {
        let ms = u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last_ms.fetch_max(ms, Ordering::Relaxed);
    }

    fn last(&self) -> tokio::time::Instant {
        self.start + Duration::from_millis(self.last_ms.load(Ordering::Relaxed))
    }
}

/// Run `work` until it finishes or `idle` passes with no byte moved through a
/// stream wrapped in [`ActivityStream`] over the same `activity`.
pub(crate) async fn until_idle<F: std::future::Future>(
    activity: &Activity,
    idle: Duration,
    work: F,
) -> Result<F::Output, io::Error> {
    tokio::pin!(work);
    loop {
        let deadline = activity.last() + idle;
        tokio::select! {
            out = &mut work => return Ok(out),
            () = tokio::time::sleep_until(deadline) => {
                if activity.last() + idle <= tokio::time::Instant::now() {
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "data phase idle"));
                }
            }
        }
    }
}

/// Run io::copy_bidirectional until it ends or no byte has moved either way
/// for `idle`. A stuck remote (one that completes the handshake, then neither
/// answers nor closes) is reclaimed; a slow upload that keeps moving is not,
/// so the server's own transfer limit is the one that ends it, with an answer
/// the webview can show.
pub(crate) async fn copy_with_deadline<A, B>(
    local: &mut A,
    remote: &mut B,
    idle: Duration,
) -> io::Result<(u64, u64)>
where
    A: io::AsyncRead + io::AsyncWrite + Unpin + ?Sized,
    B: io::AsyncRead + io::AsyncWrite + Unpin + ?Sized,
{
    let activity = Activity::new();
    let mut local = ActivityStream::new(local, Arc::clone(&activity));
    let mut remote = ActivityStream::new(remote, Arc::clone(&activity));
    until_idle(
        &activity,
        idle,
        io::copy_bidirectional(&mut local, &mut remote),
    )
    .await?
}

/// Marks its [`Activity`] whenever a read or write moves at least one byte.
pub(crate) struct ActivityStream<A> {
    inner: A,
    activity: Arc<Activity>,
}

impl<A> ActivityStream<A> {
    pub(crate) fn new(inner: A, activity: Arc<Activity>) -> Self {
        Self { inner, activity }
    }
}

impl<A: AsyncRead + Unpin> AsyncRead for ActivityStream<A> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let result = Pin::new(&mut this.inner).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            this.activity.mark();
        }
        result
    }
}

impl<A: AsyncWrite + Unpin> AsyncWrite for ActivityStream<A> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_write(cx, buf);
        if matches!(result, Poll::Ready(Ok(n)) if n > 0) {
            this.activity.mark();
        }
        result
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
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

/// Aborts the wrapped task when dropped, so a helper task cannot outlive the
/// future that started it.
pub(crate) struct AbortOnDrop(pub(crate) JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
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

/// Accept loop shared by both proxies: run each connection from `on_conn` in a
/// task owned by this loop (all are aborted and awaited when the loop exits) and,
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
    let mut conns: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();

    loop {
        tokio::select! {
            Some(joined) = conns.join_next(), if !conns.is_empty() => {
                if let Err(e) = joined {
                    if e.is_panic() {
                        error!("[{tag}] connection task panicked: {e:?}");
                    }
                }
            }
            result = listener.accept() => {
                match result {
                    Ok((stream, addr)) => {
                        consecutive_errors = 0;
                        debug!("[{tag}] accepted connection from {}", addr);
                        conns.spawn(on_conn(stream));
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

    conns.shutdown().await;
}

/// A tunnel's loopback address and the path token every request through it
/// must start with. Returned to the webview by `start_http_proxy` and
/// `start_livekit_proxy`; the client puts `/{token}` in front of each path.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct TunnelEndpoint {
    pub port: u16,
    pub token: String,
}

/// A fresh random 256-bit tunnel token, hex-encoded.
pub(crate) fn random_tunnel_token() -> Result<String, String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "no system randomness for the tunnel token".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The response for a request that does not carry the tunnel's token.
pub(crate) const FORBIDDEN_RESPONSE: &[u8] =
    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::time::{timeout, Duration};

    async fn echo_conn(mut stream: TcpStream) {
        let mut buf = [0u8; 64];
        while let Ok(n) = stream.read(&mut buf).await {
            if n == 0 || stream.write_all(&buf[..n]).await.is_err() {
                break;
            }
        }
    }

    async fn start_loop(
        on_conn: impl FnMut(TcpStream) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
            + Send
            + 'static,
    ) -> (
        std::net::SocketAddr,
        tokio::sync::oneshot::Sender<()>,
        JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let handle = tokio::spawn(run_accept_loop(listener, rx, "test", on_conn, || async {}));
        (addr, tx, handle)
    }

    fn echo_loop_conn(
        s: TcpStream,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(echo_conn(s))
    }

    #[tokio::test]
    async fn shutdown_closes_open_connections() {
        let (addr, tx, handle) = start_loop(echo_loop_conn).await;
        let mut client = TcpStream::connect(addr).await.expect("connect");
        client.write_all(b"hi").await.expect("write");
        let mut buf = [0u8; 2];
        client.read_exact(&mut buf).await.expect("echo");

        tx.send(()).expect("signal");
        timeout(Duration::from_secs(5), handle)
            .await
            .expect("loop returns")
            .expect("join");
        let n = timeout(Duration::from_secs(5), client.read(&mut buf))
            .await
            .expect("client sees close");
        assert!(matches!(n, Ok(0) | Err(_)));
    }

    #[tokio::test]
    async fn stopping_one_loop_leaves_another_loop_connections_working() {
        let (addr_a, tx_a, handle_a) = start_loop(echo_loop_conn).await;
        let (addr_b, tx_b, handle_b) = start_loop(echo_loop_conn).await;
        let mut client_a = TcpStream::connect(addr_a).await.expect("connect a");
        let mut client_b = TcpStream::connect(addr_b).await.expect("connect b");
        client_a.write_all(b"a").await.expect("write a");
        client_b.write_all(b"b").await.expect("write b");
        let mut one = [0u8; 1];
        client_a.read_exact(&mut one).await.expect("echo a");
        client_b.read_exact(&mut one).await.expect("echo b");

        tx_a.send(()).expect("signal a");
        timeout(Duration::from_secs(5), handle_a)
            .await
            .expect("loop a returns")
            .expect("join a");

        client_b.write_all(b"x").await.expect("write b after");
        timeout(Duration::from_secs(5), client_b.read_exact(&mut one))
            .await
            .expect("b responds")
            .expect("read b");
        assert_eq!(&one, b"x");

        tx_b.send(()).expect("signal b");
        timeout(Duration::from_secs(5), handle_b)
            .await
            .expect("loop b returns")
            .expect("join b");
    }

    #[tokio::test]
    async fn many_short_connections_are_served_and_loop_stops_cleanly() {
        let (addr, tx, handle) = start_loop(|mut s| {
            Box::pin(async move {
                let _ = s.write_all(b"ok").await;
            })
        })
        .await;
        for _ in 0..200 {
            let mut c = TcpStream::connect(addr).await.expect("connect");
            let mut buf = Vec::new();
            timeout(Duration::from_secs(5), c.read_to_end(&mut buf))
                .await
                .expect("read")
                .expect("io");
            assert_eq!(buf, b"ok");
        }
        tx.send(()).expect("signal");
        timeout(Duration::from_secs(5), handle)
            .await
            .expect("loop returns")
            .expect("join");
    }

    #[tokio::test]
    async fn abort_on_drop_stops_the_task_when_its_future_is_cancelled() {
        let marker = Arc::new(());
        let held = Arc::clone(&marker);
        let outer = tokio::spawn(async move {
            let _guard = AbortOnDrop(tokio::spawn(async move {
                let _held = held;
                std::future::pending::<()>().await;
            }));
            std::future::pending::<()>().await;
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(Arc::strong_count(&marker), 2);
        outer.abort();
        timeout(Duration::from_secs(5), async {
            while Arc::strong_count(&marker) != 1 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("helper task stops with its owner");
    }

    #[test]
    fn strip_tunnel_token_requires_the_exact_token() {
        let token = "ab".repeat(32);
        let req = format!("GET /{token}/api/v1/health?x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        assert_eq!(
            strip_tunnel_token(req.as_bytes(), &token).as_deref(),
            Some(&b"GET /api/v1/health?x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"[..])
        );

        for bad in [
            "GET /api/v1/health HTTP/1.1\r\n\r\n".to_string(),
            format!("GET /{}/api/v1/health HTTP/1.1\r\n\r\n", "ab".repeat(31)),
            format!("GET /{token}x/api/v1/health HTTP/1.1\r\n\r\n"),
            format!("GET /{token} HTTP/1.1\r\n\r\n"),
            format!("GET http://127.0.0.1/{token}/api HTTP/1.1\r\n\r\n"),
            format!("GET /{token}/api\r\n\r\n"),
            "\r\n\r\n".to_string(),
        ] {
            assert_eq!(strip_tunnel_token(bad.as_bytes(), &token), None, "{bad:?}");
        }
    }

    #[test]
    fn strip_tunnel_token_keeps_websocket_upgrade_paths() {
        let token = "cd".repeat(32);
        let req = format!(
            "GET /{token}/livekit/rtc/v1?access_token=t HTTP/1.1\r\nUpgrade: websocket\r\n\r\n"
        );
        let out = strip_tunnel_token(req.as_bytes(), &token).expect("valid");
        assert!(out.starts_with(b"GET /livekit/rtc/v1?access_token=t HTTP/1.1\r\n"));
        assert!(out.ends_with(b"Upgrade: websocket\r\n\r\n"));
    }

    #[test]
    fn random_tunnel_tokens_are_distinct_hex() {
        let a = random_tunnel_token().expect("token");
        let b = random_tunnel_token().expect("token");
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

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

    // IPv6 hosts that are not in the exact `[addr]:port` shape must
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

    // The data phase of a tunneled request must not be able to hang
    // forever. Simulate the stall with two in-memory duplex pairs where
    // neither peer ever writes or disconnects, so raw `io::copy_bidirectional`
    // would block forever.
    #[tokio::test(start_paused = true)]
    async fn a_transfer_that_keeps_moving_outlives_the_idle_deadline() {
        let (mut local_near, mut local_far) = tokio::io::duplex(64);
        let (mut remote_near, mut remote_far) = tokio::io::duplex(64);
        let idle = Duration::from_millis(200);

        // One byte every 50 ms for ten times the idle window, then a close.
        let writer = tokio::spawn(async move {
            for _ in 0..40 {
                local_far.write_all(b"x").await.expect("write");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            local_far.shutdown().await.expect("shutdown");
        });
        let reader = tokio::spawn(async move {
            let mut sink = Vec::new();
            remote_far.read_to_end(&mut sink).await.expect("read");
            remote_far.shutdown().await.expect("shutdown");
            sink.len()
        });

        let copied = copy_with_deadline(&mut local_near, &mut remote_near, idle).await;
        assert_eq!(
            copied.expect("a progressing transfer must not be cut").0,
            40
        );
        writer.await.expect("writer");
        assert_eq!(reader.await.expect("reader"), 40);
    }

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
