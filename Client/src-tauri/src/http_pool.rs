// Keep-alive reuse of the REST tunnel's upstream TLS connections (http_proxy).
//
// Before this, every tunneled request paid a fresh TCP + TLS handshake (two
// RTTs, docs/plans/http-tofu-proxy.md "Measured per-request TLS cost"). Now a
// bodyless GET/HEAD/OPTIONS may ride an idle upstream connection an earlier
// request left behind. The loopback side is unchanged: the webview still sends
// one request per loopback connection and is told `Connection: close`, so
// every request still arrives on its own loopback connection and gets the Host
// rewrite. Invariants a pooled connection keeps:
//
// - Keyed by the exact `remote_host` string (host and port), so a connection is
//   never reused for another host or port.
// - Tagged with the fingerprint its TLS handshake verified. `checkout` hands it
//   out only while that fingerprint is still the stored pin, and drops every
//   connection for the host that no longer is. A forgotten pin (none stored)
//   drops them too, so the next request re-runs the full TOFU check on a fresh
//   handshake. `http_proxy` also calls `invalidate` on a re-pin, a mismatch, a
//   first-use prompt and a renewal. A TLS 1.3 connection cannot change its
//   certificate mid-connection (rustls implements no renegotiation), so the
//   handshake-time check still covers every request on it.
// - Only a response whose end is known (Content-Length, chunked, or no body)
//   that did not ask to close, with nothing unread after it, returns its
//   connection to the pool. Anything else is relayed until close and dropped.
// - Bounded: at most MAX_IDLE_PER_HOST idle connections per host, each closed
//   after IDLE_TIMEOUT, well under the server's 120 s idle timeout. Idle age
//   also counts on the wall clock, so a connection idle across a system
//   suspend (which the monotonic clock skips) is not handed out.
// - A pooled socket probes its network path (TCP keepalive, and on Linux a
//   TCP user timeout), so a path that died with no FIN or RST fails the
//   socket within tens of seconds rather than holding a request until the
//   data-phase deadline. This is best-effort: a socket option the system
//   refuses is logged and the verified connection is used anyway.
// - A pooled connection that fails with an I/O error before any response
//   byte reaches the webview (closed, reset, or a dead path) is retried once
//   on a fresh connection. That is safe only because pooled requests are
//   bodyless and safe-method (GET, HEAD, OPTIONS); every other request keeps
//   the one-connection-per-request path in http_proxy. A slow answer is
//   waited for under the data-phase deadline and never replayed.

use log::debug;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};
use std::time::SystemTime;
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
    ErrorKind, ReadBuf,
};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration, Instant};

use crate::proxy_common::header_value;

pub(crate) type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Idle connections kept per host. A webview opens at most six connections
/// per origin, and a cold open's REST calls come in small bursts.
pub(crate) const MAX_IDLE_PER_HOST: usize = 4;
/// How long an idle connection is kept. Well under the server's 120 s
/// `IdleTimeout`, so the server rarely closes one first.
pub(crate) const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// TCP keepalive on a pooled socket: the first probe after KEEPALIVE_IDLE
/// without traffic, then one every KEEPALIVE_INTERVAL; the socket fails after
/// KEEPALIVE_PROBES go unanswered. Windows keeps its own probe count:
/// TCP_KEEPCNT does not exist before Windows 10 1703.
const KEEPALIVE_IDLE: Duration = Duration::from_secs(10);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(5);
#[cfg(not(windows))]
const KEEPALIVE_PROBES: u32 = 3;

/// The reply the webview gets when a connection is refused for a TLS reason:
/// the TOFU check rejected a first-use or changed certificate, or the TLS
/// handshake failed. It is a 502 carrying a small JSON body with the distinct
/// `TLS_CERT_UNVERIFIED` code, so the webview can tell a certificate failure
/// apart from an unreachable server (DP-54 follow-up). The TOFU decision flow
/// itself (what prompts, what is pinned) is unchanged — only the refusal's
/// shape.
pub(crate) fn cert_error_response() -> Vec<u8> {
    let body = serde_json::json!({
        "error": crate::tofu::TLS_CERT_ERROR_CODE,
        "message": crate::text::CERT_UNVERIFIED,
    })
    .to_string();
    format!(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    )
    .into_bytes()
}

/// Cap on a response head, and on a chunked body's trailer section.
const MAX_RESPONSE_HEAD: usize = 64 * 1024;
/// Cap on one chunk-size line (the size plus any extensions).
const MAX_CHUNK_LINE: usize = 4 * 1024;

/// Idle upstream connections, by exact `remote_host`.
pub(crate) struct ConnPool<S> {
    idle: Mutex<HashMap<String, Vec<IdleConn<S>>>>,
}

struct IdleConn<S> {
    stream: S,
    /// The fingerprint this connection's handshake verified.
    fingerprint: String,
    since: Instant,
    /// `since` on the wall clock, which unlike `Instant` keeps counting while
    /// the system is suspended.
    since_wall: SystemTime,
}

impl<S> IdleConn<S> {
    fn is_expired(&self, now: Instant) -> bool {
        now.duration_since(self.since) >= IDLE_TIMEOUT
            || !self
                .since_wall
                .elapsed()
                .is_ok_and(|age| age < IDLE_TIMEOUT)
    }
}

impl<S: AsyncRead + Unpin + Send + 'static> ConnPool<S> {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            idle: Mutex::new(HashMap::new()),
        })
    }

    /// A poisoned lock only means a panic mid-update of a socket list; the
    /// worst case is a dropped idle connection, never a trust decision.
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Vec<IdleConn<S>>>> {
        self.idle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// An idle connection to `host` verified against `pin`, the host's
    /// currently stored pin. Drops every connection for `host` that was
    /// verified against anything else, has idled too long, or was closed or
    /// written to by the server while idle.
    pub(crate) fn checkout(&self, host: &str, pin: Option<&str>) -> Option<S> {
        let mut idle = self.lock();
        let conns = idle.get_mut(host)?;
        let now = Instant::now();
        conns.retain(|conn| pin == Some(conn.fingerprint.as_str()) && !conn.is_expired(now));
        let mut found = None;
        while let Some(mut conn) = conns.pop() {
            if is_quiet(&mut conn.stream) {
                found = Some(conn.stream);
                break;
            }
        }
        if conns.is_empty() {
            idle.remove(host);
        }
        found
    }

    /// Park a connection whose last response ended cleanly, evicting the
    /// oldest one past the per-host cap, and schedule its idle expiry.
    pub(crate) fn checkin(self: &Arc<Self>, host: &str, fingerprint: String, stream: S) {
        {
            let mut idle = self.lock();
            let conns = idle.entry(host.to_string()).or_default();
            if conns.len() >= MAX_IDLE_PER_HOST {
                conns.remove(0);
            }
            conns.push(IdleConn {
                stream,
                fingerprint,
                since: Instant::now(),
                since_wall: SystemTime::now(),
            });
        }
        let expiry = Instant::now() + IDLE_TIMEOUT;
        let pool = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep_until(expiry).await;
            if let Some(pool) = pool.upgrade() {
                pool.prune_expired();
            }
        });
    }

    /// Drop every idle connection whose host maps to `store_key` (the TOFU
    /// store's key), after that key's pin changed or was questioned.
    pub(crate) fn invalidate(&self, store_key: &str) {
        self.lock()
            .retain(|host, _| crate::tofu::cert_store_key(host) != store_key);
    }

    fn prune_expired(&self) {
        let now = Instant::now();
        self.lock().retain(|_, conns| {
            conns.retain(|conn| !conn.is_expired(now));
            !conns.is_empty()
        });
    }

    #[cfg(test)]
    fn idle_count(&self) -> usize {
        self.lock().values().map(Vec::len).sum()
    }
}

/// Make a dead network path fail `tcp` within tens of seconds. Keepalive
/// probes cover an idle socket; on Linux the user timeout also covers a
/// request the server never acknowledged, which keepalive does not probe.
/// Best-effort: an option the system refuses is logged at debug, since the
/// connection already passed the TOFU check and the idle cap still bounds it.
pub(crate) fn detect_dead_path(tcp: &TcpStream) {
    let sock = socket2::SockRef::from(tcp);
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(KEEPALIVE_IDLE)
        .with_interval(KEEPALIVE_INTERVAL);
    #[cfg(not(windows))]
    let keepalive = keepalive.with_retries(KEEPALIVE_PROBES);
    if let Err(e) = sock.set_tcp_keepalive(&keepalive) {
        debug!("[http_proxy] TCP keepalive not set on a pooled connection: {e}");
    }
    #[cfg(target_os = "linux")]
    if let Err(e) =
        sock.set_tcp_user_timeout(Some(KEEPALIVE_IDLE + KEEPALIVE_INTERVAL * KEEPALIVE_PROBES))
    {
        debug!("[http_proxy] TCP user timeout not set on a pooled connection: {e}");
    }
}

/// Whether an idle connection has nothing to read: not closed, not errored,
/// and no unsolicited bytes that would be mistaken for the next response.
fn is_quiet<S: AsyncRead + Unpin>(stream: &mut S) -> bool {
    let mut byte = [0u8; 1];
    let mut buf = ReadBuf::new(&mut byte);
    let mut cx = Context::from_waker(Waker::noop());
    matches!(Pin::new(stream).poll_read(&mut cx, &mut buf), Poll::Pending)
}

/// The request method: the request line's first token.
fn method(head: &[u8]) -> &[u8] {
    head.split(|&b| b == b' ').next().unwrap_or_default()
}

/// Whether a request may ride a pooled connection and be replayed once on a
/// fresh one: a safe method with no body, no upgrade and no expectation.
/// PUT and DELETE are idempotent too, but a replayed DELETE can answer 404
/// where the first one succeeded, so they keep the one-shot path.
pub(crate) fn is_replayable(head: &[u8]) -> bool {
    matches!(method(head), b"GET" | b"HEAD" | b"OPTIONS")
        && header_value(head, "content-length").is_none_or(|v| v == "0")
        && header_value(head, "transfer-encoding").is_none()
        && header_value(head, "upgrade").is_none()
        && header_value(head, "expect").is_none()
}

fn is_head_request(head: &[u8]) -> bool {
    method(head) == b"HEAD"
}

/// Why an exchange failed, and whether it may be retried on a fresh
/// connection: only an I/O failure before anything reached the webview.
pub(crate) struct ExchangeError {
    pub(crate) retryable: bool,
    pub(crate) source: BoxError,
}

impl ExchangeError {
    fn fatal(source: impl Into<BoxError>) -> Self {
        Self {
            retryable: false,
            source: source.into(),
        }
    }
}

/// How a response body ends (RFC 9112 section 6.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Body {
    Empty,
    Length(u64),
    Chunked,
    UntilClose,
}

struct ResponseHead {
    status: u16,
    body: Body,
    keep_alive: bool,
}

/// Send `head` on `stream` and relay the response to `local`, then return the
/// connection to the pool if the response left it reusable.
pub(crate) async fn exchange<S, L>(
    pool: &Arc<ConnPool<S>>,
    host: &str,
    fingerprint: String,
    mut stream: S,
    head: &[u8],
    local: &mut L,
) -> Result<(), ExchangeError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    L: AsyncWrite + Unpin,
{
    let reusable = timeout(
        crate::http_proxy::DATA_PHASE_TIMEOUT,
        relay(&mut stream, head, local),
    )
    .await
    .map_err(|_| ExchangeError::fatal("data phase timed out"))??;
    if reusable {
        pool.checkin(host, fingerprint, stream);
    }
    Ok(())
}

/// Returns whether the connection may carry another request.
async fn relay<S, L>(stream: &mut S, head: &[u8], local: &mut L) -> Result<bool, ExchangeError>
where
    S: AsyncRead + AsyncWrite + Unpin,
    L: AsyncWrite + Unpin,
{
    let unsent = |e: std::io::Error| ExchangeError {
        retryable: e.kind() != ErrorKind::InvalidData,
        source: e.into(),
    };
    let mut remote = BufReader::new(stream);
    remote.get_mut().write_all(head).await.map_err(unsent)?;
    remote.get_mut().flush().await.map_err(unsent)?;

    let mut forwarded = false;
    let (raw, response) = loop {
        let raw = read_head(&mut remote).await.map_err(|e| {
            if forwarded {
                ExchangeError::fatal(e)
            } else {
                unsent(e)
            }
        })?;
        let response = parse_head(&raw, is_head_request(head)).map_err(ExchangeError::fatal)?;
        match response.status {
            101 => return Err(ExchangeError::fatal("unexpected protocol switch")),
            100..=199 => {
                local.write_all(&raw).await.map_err(ExchangeError::fatal)?;
                forwarded = true;
            }
            _ => break (raw, response),
        }
    };
    local
        .write_all(&close_for_webview(&raw))
        .await
        .map_err(ExchangeError::fatal)?;
    copy_body(&mut remote, local, response.body)
        .await
        .map_err(ExchangeError::fatal)?;
    local.flush().await.map_err(ExchangeError::fatal)?;
    Ok(response.keep_alive && remote.buffer().is_empty())
}

fn invalid(msg: &'static str) -> std::io::Error {
    std::io::Error::new(ErrorKind::InvalidData, msg)
}

/// One `\n`-terminated line of at most `limit` bytes.
async fn read_line<R: AsyncBufRead + Unpin>(r: &mut R, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut line = Vec::new();
    (&mut *r)
        .take(limit as u64)
        .read_until(b'\n', &mut line)
        .await?;
    if line.is_empty() {
        return Err(std::io::Error::new(
            ErrorKind::UnexpectedEof,
            "connection closed before the response ended",
        ));
    }
    if !line.ends_with(b"\n") {
        return Err(if line.len() >= limit {
            invalid("response line too long")
        } else {
            std::io::Error::new(ErrorKind::UnexpectedEof, "connection closed mid-line")
        });
    }
    Ok(line)
}

fn is_blank(line: &[u8]) -> bool {
    line == b"\r\n" || line == b"\n"
}

/// The response head, up to and including its blank line.
async fn read_head<R: AsyncBufRead + Unpin>(r: &mut R) -> std::io::Result<Vec<u8>> {
    let mut raw = Vec::new();
    loop {
        let limit = MAX_RESPONSE_HEAD.saturating_sub(raw.len());
        if limit == 0 {
            return Err(invalid("response head too large"));
        }
        let line = read_line(r, limit).await?;
        raw.extend_from_slice(&line);
        if is_blank(&line) {
            return Ok(raw);
        }
    }
}

/// The head's lines without their line endings: the status line, then the
/// header fields (the trailing blank line is dropped).
fn head_lines(raw: &[u8]) -> impl Iterator<Item = &[u8]> {
    raw.split(|&b| b == b'\n')
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line))
        .filter(|line| !line.is_empty())
}

fn parse_head(raw: &[u8], is_head: bool) -> std::io::Result<ResponseHead> {
    let mut lines = head_lines(raw);
    let status_line = std::str::from_utf8(lines.next().unwrap_or_default())
        .map_err(|_| invalid("malformed status line"))?;
    let mut parts = status_line.split(' ');
    let version = parts.next().unwrap_or_default();
    let status: u16 = parts
        .next()
        .and_then(|code| code.parse().ok())
        .filter(|code| (100..=999).contains(code))
        .ok_or_else(|| invalid("malformed status line"))?;
    let mut keep_alive = match version {
        "HTTP/1.1" => true,
        "HTTP/1.0" => false,
        _ => return Err(invalid("unsupported HTTP version")),
    };

    let mut length: Option<u64> = None;
    let mut transfer_encoding: Option<String> = None;
    for line in lines {
        let Some(colon) = line.iter().position(|&b| b == b':') else {
            return Err(invalid("malformed header line"));
        };
        let name = &line[..colon];
        let value = String::from_utf8_lossy(&line[colon + 1..]);
        let value = value.trim();
        if name.eq_ignore_ascii_case(b"content-length") {
            let parsed: u64 = value.parse().map_err(|_| invalid("bad Content-Length"))?;
            if length.is_some_and(|previous| previous != parsed) {
                return Err(invalid("conflicting Content-Length"));
            }
            length = Some(parsed);
        } else if name.eq_ignore_ascii_case(b"transfer-encoding") {
            transfer_encoding = Some(value.to_string());
        } else if name.eq_ignore_ascii_case(b"connection")
            && value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("close"))
        {
            keep_alive = false;
        }
    }

    let body = if is_head || status < 200 || status == 204 || status == 304 {
        Body::Empty
    } else if let Some(coding) = &transfer_encoding {
        // Content-Length alongside Transfer-Encoding is a smuggling shape:
        // relay by the encoding, then never reuse the connection.
        if length.is_some() {
            keep_alive = false;
        }
        let last = coding.rsplit(',').next().unwrap_or_default().trim();
        if last.eq_ignore_ascii_case("chunked") {
            Body::Chunked
        } else {
            Body::UntilClose
        }
    } else if let Some(n) = length {
        Body::Length(n)
    } else {
        Body::UntilClose
    };
    if body == Body::UntilClose {
        keep_alive = false;
    }
    Ok(ResponseHead {
        status,
        body,
        keep_alive,
    })
}

/// The response head as the webview gets it: every `Connection` field
/// replaced by one `Connection: close`, all other bytes unchanged. The
/// loopback connection ends with this response, exactly as before pooling.
fn close_for_webview(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + 19);
    let mut rest = raw;
    let mut first = true;
    while let Some(end) = rest.iter().position(|&b| b == b'\n') {
        let (line, tail) = rest.split_at(end + 1);
        rest = tail;
        if is_blank(line) {
            out.extend_from_slice(b"Connection: close\r\n");
            out.extend_from_slice(line);
            break;
        }
        let is_connection = !first
            && line
                .iter()
                .position(|&b| b == b':')
                .is_some_and(|colon| line[..colon].eq_ignore_ascii_case(b"connection"));
        first = false;
        if !is_connection {
            out.extend_from_slice(line);
        }
    }
    out
}

async fn copy_exact<R, W>(r: &mut R, w: &mut W, n: u64) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let copied = tokio::io::copy(&mut (&mut *r).take(n), w).await?;
    if copied != n {
        return Err(std::io::Error::new(
            ErrorKind::UnexpectedEof,
            "connection closed mid-body",
        ));
    }
    Ok(())
}

/// Relay the body byte for byte, reading exactly as far as its framing says.
async fn copy_body<R, W>(r: &mut R, w: &mut W, body: Body) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    match body {
        Body::Empty => Ok(()),
        Body::Length(n) => copy_exact(r, w, n).await,
        Body::UntilClose => tokio::io::copy(r, w).await.map(|_| ()),
        Body::Chunked => loop {
            let line = read_line(r, MAX_CHUNK_LINE).await?;
            w.write_all(&line).await?;
            let size = std::str::from_utf8(&line)
                .ok()
                .and_then(|text| text.split(';').next())
                .map(str::trim)
                .filter(|hex| !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()))
                .and_then(|hex| u64::from_str_radix(hex, 16).ok())
                .ok_or_else(|| invalid("bad chunk size"))?;
            if size == 0 {
                let mut trailers = 0;
                loop {
                    let limit = MAX_RESPONSE_HEAD.saturating_sub(trailers);
                    if limit == 0 {
                        return Err(invalid("chunked trailers too large"));
                    }
                    let trailer = read_line(r, limit).await?;
                    trailers += trailer.len();
                    w.write_all(&trailer).await?;
                    if is_blank(&trailer) {
                        return Ok(());
                    }
                }
            }
            copy_exact(r, w, size).await?;
            let end = read_line(r, 2).await?;
            if !is_blank(&end) {
                return Err(invalid("chunk not followed by CRLF"));
            }
            w.write_all(&end).await?;
        },
    }
}

/// A freshly dialed upstream connection that passed the TOFU check (with the
/// fingerprint it verified), or one refused for a TLS reason — a first-use or
/// changed certificate, or a failed handshake. Both refusals answer the webview
/// with the distinct certificate code via [`cert_error_response`].
pub(crate) enum Fresh<S> {
    Verified(S, String),
    Rejected(BoxError),
}

/// Relay one replayable request: on an idle pooled connection if one verified
/// against the current `pin` exists, otherwise, or once if that connection
/// fails before any response byte reaches the webview, on a fresh one from
/// `dial`. Only a failed dial or a TOFU rejection is returned as an error; a
/// failed exchange (the webview aborting a fetch, the server closing) is
/// logged at debug, as on the one-shot path.
pub(crate) async fn forward_replayable<S, L, D, F>(
    pool: &Arc<ConnPool<S>>,
    host: &str,
    pin: Option<&str>,
    head: &[u8],
    local: &mut L,
    dial: D,
) -> Result<(), BoxError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    L: AsyncWrite + Unpin,
    D: FnOnce() -> F,
    F: Future<Output = Result<Fresh<S>, BoxError>>,
{
    if let (Some(stream), Some(pin)) = (pool.checkout(host, pin), pin) {
        match exchange(pool, host, pin.to_string(), stream, head, local).await {
            Err(e) if e.retryable => debug!(
                "[http_proxy] pooled connection to {host} failed before a response ({}); retrying on a fresh one",
                e.source
            ),
            result => {
                log_exchange(result);
                return Ok(());
            }
        }
    }
    let (stream, fingerprint) = match dial().await? {
        Fresh::Verified(stream, fingerprint) => (stream, fingerprint),
        Fresh::Rejected(e) => {
            let _ = local.write_all(&cert_error_response()).await;
            return Err(e);
        }
    };
    log_exchange(exchange(pool, host, fingerprint, stream, head, local).await);
    Ok(())
}

fn log_exchange(result: Result<(), ExchangeError>) {
    if let Err(e) = result {
        debug!("[http_proxy] pooled exchange ended: {}", e.source);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy_common::read_request_headers;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
    use tokio::io::{duplex, AsyncReadExt, DuplexStream};

    const HOST: &str = "chat.example:8443";
    const FP: &str = "aa:aa";
    const OTHER_FP: &str = "bb:bb";
    const GET: &[u8] =
        b"GET /api/v1/server-info HTTP/1.1\r\nHost: chat.example:8443\r\nConnection: keep-alive\r\n\r\n";
    const HEAD: &[u8] = b"HEAD /api/v1/server-info HTTP/1.1\r\nHost: chat.example:8443\r\n\r\n";
    const OK: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";

    /// A scripted upstream connection. It reads one request head per entry in
    /// `replies` and answers it with that reply; a `None` reply reads the
    /// request and then closes without answering (the server dropping a
    /// kept-alive connection as the request arrives). Once the script runs out
    /// it closes if `then_close`, otherwise it stays open and idle.
    fn upstream(
        replies: Vec<Option<&'static [u8]>>,
        then_close: bool,
    ) -> (DuplexStream, Arc<AtomicUsize>) {
        let (client, mut server) = duplex(64 * 1024);
        let seen = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&seen);
        tokio::spawn(async move {
            for reply in replies {
                if read_request_headers(&mut server).await.is_err() {
                    return;
                }
                count.fetch_add(1, SeqCst);
                match reply {
                    Some(bytes) => {
                        if server.write_all(bytes).await.is_err() {
                            return;
                        }
                    }
                    None => return,
                }
            }
            if !then_close {
                let mut rest = Vec::new();
                let _ = server.read_to_end(&mut rest).await;
            }
        });
        (client, seen)
    }

    /// One replayable GET through the pool, as the webview would send it.
    /// `fresh` is the connection a dial returns. Yields what the webview
    /// received and whether a fresh connection was dialed.
    async fn fetch(
        pool: &Arc<ConnPool<DuplexStream>>,
        host: &str,
        pin: Option<&str>,
        fresh: Option<DuplexStream>,
    ) -> (Result<String, BoxError>, bool) {
        let (mut local, mut webview) = duplex(64 * 1024);
        let dialed = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&dialed);
        let result = forward_replayable(pool, host, pin, GET, &mut local, move || async move {
            flag.store(true, SeqCst);
            fresh
                .map(|stream| Fresh::Verified(stream, FP.to_string()))
                .ok_or_else(|| BoxError::from("no fresh connection scripted"))
        })
        .await;
        drop(local);
        let mut got = String::new();
        webview
            .read_to_string(&mut got)
            .await
            .expect("read webview side");
        (result.map(|()| got), dialed.load(SeqCst))
    }

    /// Relay one reply over a fresh connection and report what the webview got
    /// and whether the connection went back to the pool.
    async fn relay_once(reply: &'static [u8], then_close: bool, is_head: bool) -> (String, bool) {
        let pool = ConnPool::new();
        let (conn, _) = upstream(vec![Some(reply)], then_close);
        let (mut local, mut webview) = duplex(64 * 1024);
        let request = if is_head { HEAD } else { GET };
        let result = exchange(&pool, HOST, FP.into(), conn, request, &mut local).await;
        assert!(
            result.is_ok(),
            "exchange failed: {}",
            result
                .err()
                .map(|e| e.source.to_string())
                .unwrap_or_default()
        );
        drop(local);
        let mut got = String::new();
        webview
            .read_to_string(&mut got)
            .await
            .expect("read webview side");
        (got, pool.checkout(HOST, Some(FP)).is_some())
    }

    fn connection_headers(response: &str) -> usize {
        response
            .to_ascii_lowercase()
            .matches("\r\nconnection:")
            .count()
    }

    #[tokio::test]
    async fn a_second_request_to_the_same_host_reuses_the_connection() {
        let pool = ConnPool::new();
        let (conn, seen) = upstream(vec![Some(OK), Some(OK)], false);

        let (first, dialed) = fetch(&pool, HOST, Some(FP), Some(conn)).await;
        let first = first.expect("first request");
        assert!(dialed, "an empty pool dials");
        assert!(first.ends_with("\r\n\r\nok"));
        assert!(
            first.contains("\r\nConnection: close\r\n"),
            "the webview side still sees one request per loopback connection"
        );

        let (second, dialed) = fetch(&pool, HOST, Some(FP), None).await;
        assert!(
            !dialed,
            "the idle connection must be reused, not a new one dialed"
        );
        assert!(second.expect("second request").ends_with("\r\n\r\nok"));
        assert_eq!(
            seen.load(SeqCst),
            2,
            "both requests rode one upstream connection"
        );
    }

    #[tokio::test]
    async fn a_connection_is_never_reused_for_another_host_or_port() {
        let pool = ConnPool::new();
        let (conn, _) = upstream(vec![Some(OK), Some(OK)], false);
        fetch(&pool, HOST, Some(FP), Some(conn))
            .await
            .0
            .expect("first request");

        for other in ["chat.example:8444", "other.example:8443"] {
            let (fresh, _) = upstream(vec![Some(OK)], false);
            let (result, dialed) = fetch(&pool, other, Some(FP), Some(fresh)).await;
            result.expect("request to another host");
            assert!(dialed, "{other} must dial its own connection");
        }
        assert!(
            pool.checkout(HOST, Some(FP)).is_some(),
            "the original host keeps its idle connection"
        );
    }

    #[tokio::test]
    async fn a_changed_pin_drops_the_pooled_connections() {
        let pool = ConnPool::new();
        pool.checkin(HOST, FP.into(), upstream(vec![], false).0);
        assert_eq!(pool.idle_count(), 1);
        assert!(
            pool.checkout(HOST, Some(OTHER_FP)).is_none(),
            "a connection verified against the old pin must not serve the new one"
        );
        assert_eq!(
            pool.idle_count(),
            0,
            "and it is dropped, not kept for the old pin"
        );
    }

    #[tokio::test]
    async fn a_forgotten_pin_drops_the_pooled_connections() {
        let pool = ConnPool::new();
        pool.checkin(HOST, FP.into(), upstream(vec![], false).0);
        assert!(pool.checkout(HOST, None).is_none());
        assert_eq!(pool.idle_count(), 0);
    }

    #[tokio::test]
    async fn invalidate_drops_every_connection_for_the_store_key() {
        let pool = ConnPool::new();
        for host in ["Chat.Example:443", "chat.example:8443", "other.example"] {
            pool.checkin(host, FP.into(), upstream(vec![], false).0);
        }
        // What a re-pin, a mismatch or a first-use prompt for the key does.
        pool.invalidate("chat.example");
        assert!(pool.checkout("Chat.Example:443", Some(FP)).is_none());
        assert!(
            pool.checkout("chat.example:8443", Some(FP)).is_some(),
            "another port is another key"
        );
        assert!(pool.checkout("other.example", Some(FP)).is_some());
    }

    #[tokio::test]
    async fn a_pooled_connection_the_server_dropped_falls_back_to_a_fresh_one() {
        let pool = ConnPool::new();
        // Answers once, then closes as the next request arrives.
        let (conn, _) = upstream(vec![Some(OK), None], false);
        fetch(&pool, HOST, Some(FP), Some(conn))
            .await
            .0
            .expect("first request");

        let (fresh, fresh_seen) = upstream(vec![Some(OK)], false);
        let (result, dialed) = fetch(&pool, HOST, Some(FP), Some(fresh)).await;
        assert!(
            dialed,
            "the failed pooled request is retried on a fresh connection"
        );
        assert!(result.expect("retried request").ends_with("\r\n\r\nok"));
        assert_eq!(fresh_seen.load(SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_answer_on_a_pooled_connection_is_waited_for_not_replayed() {
        let pool = ConnPool::new();
        let (conn, mut server) = duplex(64 * 1024);
        tokio::spawn(async move {
            for delay in [0, 20] {
                read_request_headers(&mut server).await.expect("request");
                tokio::time::sleep(Duration::from_secs(delay)).await;
                server.write_all(OK).await.expect("reply");
            }
            let _ = server.read_to_end(&mut Vec::new()).await;
        });
        fetch(&pool, HOST, Some(FP), Some(conn))
            .await
            .0
            .expect("first request");

        let start = Instant::now();
        let (fresh, fresh_seen) = upstream(vec![Some(OK)], false);
        let (result, dialed) = fetch(&pool, HOST, Some(FP), Some(fresh)).await;
        assert!(
            !dialed,
            "a live server's slow answer must not be replayed on a fresh connection"
        );
        assert_eq!(fresh_seen.load(SeqCst), 0);
        assert!(result.expect("slow request").ends_with("\r\n\r\nok"));
        assert!(start.elapsed() >= Duration::from_secs(20));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_pooled_socket_fails_within_seconds_once_its_path_dies() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let tcp = TcpStream::connect(listener.local_addr().expect("addr"))
            .await
            .expect("connect");
        detect_dead_path(&tcp);
        let sock = socket2::SockRef::from(&tcp);
        assert!(sock.keepalive().expect("keepalive"));
        assert_eq!(sock.tcp_keepalive_time().expect("time"), KEEPALIVE_IDLE);
        assert_eq!(
            sock.tcp_keepalive_interval().expect("interval"),
            KEEPALIVE_INTERVAL
        );
        assert_eq!(
            sock.tcp_keepalive_retries().expect("retries"),
            KEEPALIVE_PROBES
        );
        assert_eq!(
            sock.tcp_user_timeout().expect("user timeout"),
            Some(Duration::from_secs(25)),
            "unacknowledged request bytes fail the socket as fast as unanswered probes"
        );
    }

    #[tokio::test]
    async fn a_request_is_retried_at_most_once() {
        let pool = ConnPool::new();
        let (conn, _) = upstream(vec![Some(OK), None], false);
        fetch(&pool, HOST, Some(FP), Some(conn))
            .await
            .0
            .expect("first request");

        let (fresh, _) = upstream(vec![None], false);
        let (result, dialed) = fetch(&pool, HOST, Some(FP), Some(fresh)).await;
        assert!(dialed);
        assert_eq!(
            result.expect("a failed exchange is logged, not returned"),
            "",
            "a fresh connection that also fails is not retried again"
        );
    }

    #[tokio::test]
    async fn an_idle_connection_the_server_closed_is_not_checked_out() {
        let pool = ConnPool::new();
        let (client, server) = duplex(1024);
        pool.checkin(HOST, FP.into(), client);
        drop(server);
        assert!(pool.checkout(HOST, Some(FP)).is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn the_pool_is_capped_and_idle_connections_expire() {
        let pool = ConnPool::new();
        for _ in 0..MAX_IDLE_PER_HOST + 2 {
            pool.checkin(HOST, FP.into(), upstream(vec![], false).0);
        }
        assert_eq!(pool.idle_count(), MAX_IDLE_PER_HOST);
        tokio::time::advance(IDLE_TIMEOUT).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            pool.idle_count(),
            0,
            "idle connections are closed after the timeout"
        );
    }

    #[tokio::test]
    async fn a_chunked_response_is_relayed_intact_and_pooled() {
        let reply: &[u8] = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n3;x=1\r\n!!!\r\n0\r\nX-Trailer: t\r\n\r\n";
        let (got, pooled) = relay_once(reply, false, false).await;
        assert!(got.ends_with("\r\n\r\n2\r\nok\r\n3;x=1\r\n!!!\r\n0\r\nX-Trailer: t\r\n\r\n"));
        assert!(pooled);
    }

    #[tokio::test]
    async fn a_response_that_closes_is_not_pooled() {
        let (got, pooled) = relay_once(
            b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok",
            false,
            false,
        )
        .await;
        assert!(got.ends_with("\r\n\r\nok"));
        assert_eq!(connection_headers(&got), 1);
        assert!(!pooled);

        let (got, pooled) = relay_once(
            b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok",
            false,
            false,
        )
        .await;
        assert!(got.ends_with("\r\n\r\nok"));
        assert!(!pooled, "an HTTP/1.0 response is not kept alive");
    }

    #[tokio::test]
    async fn a_body_delimited_by_close_is_relayed_and_not_pooled() {
        let (got, pooled) =
            relay_once(b"HTTP/1.1 200 OK\r\n\r\nstreamed until close", true, false).await;
        assert!(got.ends_with("\r\n\r\nstreamed until close"));
        assert!(!pooled);
    }

    #[tokio::test]
    async fn bodyless_responses_do_not_wait_for_a_body() {
        let (got, pooled) = relay_once(
            b"HTTP/1.1 200 OK\r\nContent-Length: 1234\r\n\r\n",
            false,
            true,
        )
        .await;
        assert!(got.ends_with("Content-Length: 1234\r\nConnection: close\r\n\r\n"));
        assert!(pooled, "a HEAD response carries no body");

        let (_, pooled) = relay_once(b"HTTP/1.1 204 No Content\r\n\r\n", false, false).await;
        assert!(pooled);
    }

    #[tokio::test]
    async fn the_webview_sees_exactly_one_connection_close() {
        let (got, pooled) = relay_once(
            b"HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nok",
            false,
            false,
        )
        .await;
        assert!(got.contains("\r\nConnection: close\r\n"));
        assert!(!got.to_ascii_lowercase().contains("keep-alive"));
        assert_eq!(connection_headers(&got), 1);
        assert!(pooled);
    }

    #[tokio::test]
    async fn bytes_after_the_response_keep_the_connection_out_of_the_pool() {
        let (got, pooled) = relay_once(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokX",
            false,
            false,
        )
        .await;
        assert!(got.ends_with("\r\n\r\nok"), "the stray byte is not relayed");
        assert!(
            !pooled,
            "an out-of-sync connection would answer the next request wrongly"
        );
    }

    // DP-54 follow-up: a tunnel that refuses a certificate must say so with a
    // distinct code, not an empty 502, so the webview can show the certificate
    // message instead of the generic unreachable copy. The TOFU decision flow
    // is unchanged — only the refusal's body.
    #[test]
    fn a_certificate_refusal_is_a_json_502_carrying_the_distinct_code() {
        let response = cert_error_response();
        let text = String::from_utf8(response).expect("response is valid utf-8");
        let (head, body) = text
            .split_once("\r\n\r\n")
            .expect("the response has a header/body boundary");
        assert!(head.starts_with("HTTP/1.1 502 "), "head: {head:?}");
        assert!(
            head.to_ascii_lowercase()
                .contains("content-type: application/json"),
            "the webview must parse a JSON body: {head:?}"
        );
        let declar: Option<&str> = head
            .lines()
            .find_map(|l| l.strip_prefix("Content-Length: "));
        assert_eq!(
            declar.and_then(|n| n.trim().parse::<usize>().ok()),
            Some(body.len()),
            "the declared length must match the body"
        );
        let parsed: serde_json::Value = serde_json::from_str(body).expect("body is JSON");
        assert_eq!(
            parsed.get("error").and_then(serde_json::Value::as_str),
            Some(crate::tofu::TLS_CERT_ERROR_CODE),
        );
    }

    #[test]
    fn only_bodyless_safe_requests_are_replayable() {
        let replayable: [&[u8]; 4] = [
            b"GET /a HTTP/1.1\r\nHost: h\r\n\r\n",
            b"HEAD /a HTTP/1.1\r\nHost: h\r\n\r\n",
            b"OPTIONS /a HTTP/1.1\r\nHost: h\r\n\r\n",
            b"GET /a HTTP/1.1\r\nHost: h\r\nContent-Length: 0\r\n\r\n",
        ];
        for head in replayable {
            assert!(is_replayable(head), "{}", String::from_utf8_lossy(head));
        }
        let not_replayable: [&[u8]; 7] = [
            b"POST /a HTTP/1.1\r\nHost: h\r\nContent-Length: 2\r\n\r\n",
            b"PATCH /a HTTP/1.1\r\nHost: h\r\n\r\n",
            b"PUT /a HTTP/1.1\r\nHost: h\r\n\r\n",
            b"DELETE /a HTTP/1.1\r\nHost: h\r\n\r\n",
            b"GET /a HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\n\r\n",
            b"GET /a HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n",
            b"GET /a HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        ];
        for head in not_replayable {
            assert!(!is_replayable(head), "{}", String::from_utf8_lossy(head));
        }
        assert!(is_head_request(b"HEAD /a HTTP/1.1\r\n\r\n"));
        assert!(!is_head_request(b"GET /a HTTP/1.1\r\n\r\n"));
    }
}
