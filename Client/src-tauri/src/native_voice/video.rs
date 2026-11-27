//! Video frames between the native room and the webview, over a per-session
//! loopback WebSocket ("frame socket").
//!
//! Frames never cross Tauri IPC: on WebKitGTK the invoke path serialises
//! binary as JSON, which tops out around 19 fps for one 720p I420 frame
//! (docs/architecture/voice-e2ee.md). Instead each session binds its own
//! listener on 127.0.0.1 with a random 256-bit token; the URL (with the
//! token) reaches the webview only as the `native_voice_connect` result, and
//! the handshake is refused unless the path carries it, so no other local
//! process can read or inject frames. Dropping the `FrameServer` (session
//! close) aborts the listener and every connection it accepted.
//!
//! Routes, each one WebSocket:
//! - `/<token>/remote/<track sid>`: decoded frames of one subscribed remote
//!   video track, server to webview, as [`pack_i420`] messages. The webview
//!   acknowledges each frame it has drawn with any data message, and the
//!   next frame is sent only after that ack; meanwhile only the latest
//!   decoded frame is kept, so a slow renderer drops frames instead of
//!   queueing them anywhere (the webview's socket reads eagerly, so TCP
//!   backpressure alone would not).
//! - `/<token>/camera`: the local camera capture's preview, server to
//!   webview, acknowledged like a remote track; it ends with the capture. The
//!   pixels are captured and published natively (`camera.rs`), so the webview
//!   only reads them back for the self-view and the settings preview.
//! - `/<token>/screen`: the local screen capture's preview, server to
//!   webview, acknowledged like a remote track; it ends with the capture.
//!
//! Both previews are scaled to fit [`PREVIEW_MAX`] and sent at most once per
//! [`PREVIEW_INTERVAL`]: they are only ever drawn in a tile, and a 4K60 share
//! at full size would push about 750 MB/s through this socket and WebKit on
//! top of its encode. The published track keeps the capture's size and rate.
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use livekit::prelude::*;
use livekit::webrtc::prelude::{BoxVideoFrame, I420Buffer, VideoBuffer};
use livekit::webrtc::video_stream::native::NativeVideoStream;
use ring::rand::{SecureRandom, SystemRandom};
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use super::screen::Preview;
use crate::sync::lock;

/// State the connection tasks share with the session.
#[derive(Default)]
struct Shared {
    /// Subscribed remote video tracks by sid, kept current from the room's
    /// events before they reach the webview.
    remote: Mutex<HashMap<String, RemoteVideoTrack>>,
    /// The running camera capture's preview; `None` while no camera runs.
    camera: Mutex<Option<Arc<Preview>>>,
    /// The running screen capture's preview; `None` while not capturing.
    screen: Mutex<Option<Arc<Preview>>>,
    /// Open frame-socket connections, for the debug surface.
    sockets: AtomicUsize,
}

pub struct FrameServer {
    url: String,
    shared: Arc<Shared>,
    accept: JoinHandle<()>,
}

impl FrameServer {
    pub async fn bind() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("frame socket bind: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let token = random_token()?;
        let url = format!("ws://127.0.0.1:{port}/{token}");
        let shared = Arc::new(Shared::default());
        let accept = tokio::spawn(accept_loop(listener, token, shared.clone()));
        Ok(Self {
            url,
            shared,
            accept,
        })
    }

    /// The base URL (with the token) the webview appends a route to.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// A handle the room's event forwarder uses to keep the remote track
    /// table current.
    pub fn observer(&self) -> Observer {
        Observer(self.shared.clone())
    }

    pub fn set_camera(&self, preview: Option<Arc<Preview>>) {
        *lock(&self.shared.camera) = preview;
    }

    pub fn set_screen(&self, preview: Option<Arc<Preview>>) {
        *lock(&self.shared.screen) = preview;
    }

    pub fn sockets(&self) -> usize {
        self.shared.sockets.load(Ordering::Relaxed)
    }
}

impl Drop for FrameServer {
    /// Aborting the accept task drops its `JoinSet`, which aborts every
    /// connection it accepted.
    fn drop(&mut self) {
        self.accept.abort();
    }
}

pub struct Observer(Arc<Shared>);

impl Observer {
    /// Track the room's remote video subscriptions.
    pub fn observe(&self, event: &RoomEvent) {
        let mut remote = lock(&self.0.remote);
        match event {
            RoomEvent::TrackSubscribed {
                track: RemoteTrack::Video(track),
                publication,
                ..
            } => {
                remote.insert(publication.sid().to_string(), track.clone());
            }
            RoomEvent::TrackUnsubscribed { publication, .. } => {
                remote.remove(&publication.sid().to_string());
            }
            RoomEvent::Disconnected { .. } => remote.clear(),
            _ => {}
        }
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "no system randomness for the frame socket token".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, PartialEq)]
enum Route {
    Remote(String),
    Camera,
    Screen,
}

/// The route of a request path, or `None` when the token does not match.
fn route(path: &str, token: &str) -> Option<Route> {
    let mut parts = path.strip_prefix('/')?.splitn(3, '/');
    if !constant_time_eq(parts.next()?.as_bytes(), token.as_bytes()) {
        return None;
    }
    match (parts.next()?, parts.next()) {
        ("remote", Some(sid)) if !sid.is_empty() => Some(Route::Remote(sid.to_string())),
        ("camera", None) => Some(Route::Camera),
        ("screen", None) => Some(Route::Screen),
        _ => None,
    }
}

/// Where the accept loop gets connections from; the listener in production,
/// a scripted source in tests.
trait Accept {
    async fn accept(&mut self) -> std::io::Result<tokio::net::TcpStream>;
}

impl Accept for TcpListener {
    async fn accept(&mut self) -> std::io::Result<tokio::net::TcpStream> {
        TcpListener::accept(self).await.map(|(stream, _)| stream)
    }
}

/// How long to wait after a failed accept before trying again, so a
/// persistent error (for example out of file descriptors) does not spin.
const ACCEPT_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(75);

/// How long a connection has to finish its WebSocket handshake.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Connections served at once: one per remote camera or screen share (the
/// server allows up to 99 video users, two tracks each) plus the two local
/// previews, with room for tiles reconnecting. Anything past this is closed
/// at once.
const MAX_CONNECTIONS: usize = 256;

/// Serves connections until the owner aborts the task. An accept error is
/// logged and retried: ending here would drop the connection set and cut
/// every preview for the rest of the call.
async fn accept_loop<A: Accept>(mut source: A, token: String, shared: Arc<Shared>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = source.accept() => match accepted {
                Ok(stream) if connections.len() >= MAX_CONNECTIONS => {
                    log::debug!("[native_voice] frame socket full: connection closed");
                    drop(stream);
                }
                Ok(stream) => {
                    connections.spawn(serve(stream, token.clone(), shared.clone()));
                }
                Err(e) => {
                    log::warn!("[native_voice] frame socket accept: {e}");
                    tokio::time::sleep(ACCEPT_RETRY_DELAY).await;
                }
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

/// Decrements the socket count however the connection task ends (abort too).
struct Counted(Arc<Shared>);

impl Drop for Counted {
    fn drop(&mut self) {
        self.0.sockets.fetch_sub(1, Ordering::Relaxed);
    }
}

// The handshake callback's error type is tungstenite's `ErrorResponse`, a
// full HTTP response; its size is not ours to choose.
#[allow(clippy::result_large_err)]
async fn serve(stream: tokio::net::TcpStream, token: String, shared: Arc<Shared>) {
    let mut chosen = None;
    let authorize = |req: &Request, resp: Response| match route(req.uri().path(), &token) {
        Some(r) => {
            chosen = Some(r);
            Ok(resp)
        }
        None => {
            let mut refused = ErrorResponse::new(None);
            *refused.status_mut() = StatusCode::FORBIDDEN;
            Err(refused)
        }
    };
    // The path carries the token: never log it.
    let handshake = tokio_tungstenite::accept_hdr_async(stream, authorize);
    let Ok(Ok(ws)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake).await else {
        log::debug!("[native_voice] frame socket handshake refused or timed out");
        return;
    };
    let Some(route) = chosen else { return };
    shared.sockets.fetch_add(1, Ordering::Relaxed);
    let _counted = Counted(shared.clone());
    match route {
        Route::Remote(sid) => {
            let track = lock(&shared.remote).get(&sid).cloned();
            match track {
                Some(track) => send_remote(ws, track).await,
                None => log::debug!("[native_voice] frame socket: no subscribed video {sid}"),
            }
        }
        Route::Camera => {
            let preview = lock(&shared.camera).as_ref().map(|p| p.subscribe());
            match preview {
                Some(preview) => send_preview(ws, preview).await,
                None => log::debug!("[native_voice] frame socket: no camera capture"),
            }
        }
        Route::Screen => {
            let preview = lock(&shared.screen).as_ref().map(|p| p.subscribe());
            match preview {
                Some(preview) => send_preview(ws, preview).await,
                None => log::debug!("[native_voice] frame socket: no screen capture"),
            }
        }
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

async fn send_remote(ws: Ws, track: RemoteVideoTrack) {
    let mut frames = NativeVideoStream::new(track.rtc_track());
    // A frame past the ceiling (`remote_frame_fits`) is dropped before it is
    // converted and copied for the page; the first one is logged.
    let mut drawn = Fitting {
        inner: &mut frames,
        logged: false,
    };
    send_acked(ws, &mut drawn, |frame| pack_i420(&frame.buffer.to_i420())).await;
    frames.close();
}

/// The width and height of a received frame, read before it is converted.
trait FrameSize {
    fn frame_size(&self) -> (u32, u32);
}

impl FrameSize for BoxVideoFrame {
    fn frame_size(&self) -> (u32, u32) {
        (self.buffer.width(), self.buffer.height())
    }
}

/// Passes on the items whose size fits the received-frame ceiling
/// (`remote_frame_fits`) and drops the rest, logging the first one dropped.
///
/// A named adapter rather than `StreamExt::filter`: a closure (or fn
/// pointer) over `&BoxVideoFrame` held in the connection task fails the
/// task's `Send` check, since the frame's `dyn VideoBuffer` lifetime is not
/// general enough there. A trait bound on the item does not.
struct Fitting<S> {
    inner: S,
    logged: bool,
}

impl<S> futures_util::Stream for Fitting<S>
where
    S: futures_util::Stream + Unpin,
    S::Item: FrameSize,
{
    type Item = S::Item;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<S::Item>> {
        let this = self.get_mut();
        loop {
            let item = match Pin::new(&mut this.inner).poll_next(cx) {
                Poll::Ready(Some(item)) => item,
                other => return other,
            };
            let (w, h) = item.frame_size();
            if owncord_parse::voice::remote_frame_fits(w, h) {
                return Poll::Ready(Some(item));
            }
            if !this.logged {
                this.logged = true;
                log::warn!("[native_voice] dropping received video frames of {w}x{h}");
            }
        }
    }
}

/// The largest preview frame sent: a local preview is drawn in a tile, never
/// at the capture's full size.
const PREVIEW_MAX: (u32, u32) = (1280, 720);

/// The shortest time between two preview frames (about 30 a second).
const PREVIEW_INTERVAL: Duration = Duration::from_millis(33);

async fn send_preview(ws: Ws, preview: tokio::sync::watch::Receiver<Option<Arc<I420Buffer>>>) {
    // Ends when the capture drops its sender. The watch keeps only the
    // newest frame, so the wait between frames never shows a stale one.
    let mut frames = Box::pin(futures_util::stream::unfold(
        (preview, None),
        |(mut rx, last): (_, Option<tokio::time::Instant>)| async move {
            if let Some(last) = last {
                tokio::time::sleep_until(last + PREVIEW_INTERVAL).await;
            }
            rx.changed().await.ok()?;
            let frame = rx.borrow_and_update().clone();
            Some((frame, (rx, Some(tokio::time::Instant::now()))))
        },
    ));
    send_acked(ws, &mut frames, |frame| {
        frame.map(|f| pack_preview(&f)).unwrap_or_default()
    })
    .await;
}

/// `frame` packed like [`pack_i420`], scaled down first when it is larger
/// than [`PREVIEW_MAX`]. The capture shares the frame, so the scale works on
/// a copy.
fn pack_preview(frame: &I420Buffer) -> Vec<u8> {
    let raw = (frame.width(), frame.height());
    let (w, h) = preview_size(raw);
    if (w, h) == raw {
        return pack_i420(frame);
    }
    // `to_i420` is reachable only through the trait object; for an I420
    // buffer it is a copy.
    let shared: &dyn VideoBuffer = frame;
    pack_i420(&shared.to_i420().scale(w as i32, h as i32))
}

/// The size a `raw` frame is sent at: unchanged when it fits [`PREVIEW_MAX`],
/// otherwise the largest size that fits it with the same aspect ratio, in
/// even pixels so the chroma planes stay whole.
fn preview_size(raw: (u32, u32)) -> (u32, u32) {
    let (w, h) = (u64::from(raw.0), u64::from(raw.1));
    let (max_w, max_h) = (u64::from(PREVIEW_MAX.0), u64::from(PREVIEW_MAX.1));
    if w <= max_w && h <= max_h {
        return raw;
    }
    let (w, h) = if w * max_h >= h * max_w {
        (max_w, h * max_w / w)
    } else {
        (w * max_h / h, max_h)
    };
    let even = |v: u64| (v as u32 & !1).max(2);
    (even(w), even(h))
}

/// Send `frames` one at a time, each only after the previous one was
/// acknowledged, keeping just the latest while waiting.
async fn send_acked<S: futures_util::Stream + Unpin>(
    ws: Ws,
    frames: &mut S,
    pack: impl Fn(S::Item) -> Vec<u8>,
) {
    let (mut tx, mut rx) = ws.split();
    let mut acked = true;
    let mut latest = None;
    loop {
        tokio::select! {
            frame = frames.next() => {
                let Some(frame) = frame else { break };
                latest = Some(frame);
            }
            msg = rx.next() => match msg {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(Message::Binary(_) | Message::Text(_))) => acked = true,
                Some(Ok(_)) => {}
            },
        }
        if acked {
            if let Some(frame) = latest.take() {
                acked = false;
                if tx.send(Message::Binary(pack(frame).into())).await.is_err() {
                    break;
                }
            }
        }
    }
}

/// A decoded frame as the webview renderer reads it: width and height
/// (little-endian u32), then the Y, U and V planes tightly packed.
pub fn pack_i420(buffer: &I420Buffer) -> Vec<u8> {
    let (w, h) = (buffer.width() as usize, buffer.height() as usize);
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    let (sy, su, sv) = buffer.strides();
    let (y, u, v) = buffer.data();
    let mut out = Vec::with_capacity(8 + w * h + 2 * cw * ch);
    out.extend_from_slice(&(w as u32).to_le_bytes());
    out.extend_from_slice(&(h as u32).to_le_bytes());
    for (plane, stride, width, rows) in [
        (y, sy as usize, w, h),
        (u, su as usize, cw, ch),
        (v, sv as usize, cw, ch),
    ] {
        for row in 0..rows {
            out.extend_from_slice(&plane[row * stride..row * stride + width]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_require_the_exact_token() {
        let token = "ab".repeat(32);
        assert_eq!(
            route(&format!("/{token}/remote/TR_1"), &token),
            Some(Route::Remote("TR_1".into()))
        );
        assert_eq!(
            route(&format!("/{token}/camera"), &token),
            Some(Route::Camera)
        );
        assert_eq!(
            route(&format!("/{token}/screen"), &token),
            Some(Route::Screen)
        );
        assert_eq!(route(&format!("/{}/camera", "ab".repeat(31)), &token), None);
        assert_eq!(route(&format!("/{}x/camera", token), &token), None);
        assert_eq!(route("/camera", &token), None);
        assert_eq!(route(&format!("/{token}/remote/"), &token), None);
        assert_eq!(route(&format!("/{token}/camera/extra"), &token), None);
        assert_eq!(route(&format!("/{token}"), &token), None);
    }

    /// The next binary message, or `None` if none arrives within 200 ms.
    async fn recv<S, E>(ws: &mut S) -> Option<Vec<u8>>
    where
        S: futures_util::Stream<Item = Result<Message, E>> + Unpin,
    {
        match tokio::time::timeout(std::time::Duration::from_millis(200), ws.next()).await {
            Ok(Some(Ok(Message::Binary(data)))) => Some(data.to_vec()),
            _ => None,
        }
    }

    /// Fails the first accept, then hands out the real listener's connections.
    struct FlakyAccept {
        listener: TcpListener,
        failed: bool,
    }

    impl Accept for FlakyAccept {
        async fn accept(&mut self) -> std::io::Result<tokio::net::TcpStream> {
            if !self.failed {
                self.failed = true;
                return Err(std::io::Error::other("injected accept failure"));
            }
            self.listener.accept().await.map(|(stream, _)| stream)
        }
    }

    #[tokio::test]
    async fn a_failed_accept_does_not_end_the_frame_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "cd".repeat(32);
        let source = FlakyAccept {
            listener,
            failed: false,
        };
        let task = tokio::spawn(accept_loop(
            source,
            token.clone(),
            Arc::new(Shared::default()),
        ));

        let url = format!("ws://127.0.0.1:{port}/{token}/camera");
        let connected = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio_tungstenite::connect_async(url),
        )
        .await;
        assert!(
            matches!(connected, Ok(Ok(_))),
            "a connection after the failed accept is served"
        );
        assert!(!task.is_finished(), "the accept loop is still running");
        task.abort();
    }

    #[tokio::test]
    async fn a_connection_that_never_finishes_its_handshake_is_closed() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(accept_loop(
            listener,
            "ef".repeat(32),
            Arc::new(Shared::default()),
        ));
        let mut silent = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut buf = [0u8; 1];
        let read = tokio::time::timeout(
            HANDSHAKE_TIMEOUT + std::time::Duration::from_secs(2),
            tokio::io::AsyncReadExt::read(&mut silent, &mut buf),
        )
        .await;
        assert!(
            matches!(read, Ok(Ok(0)) | Ok(Err(_))),
            "the server closed the silent connection: {read:?}"
        );
        task.abort();
    }

    #[tokio::test]
    async fn connections_past_the_cap_are_closed_at_once() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let token = "ab".repeat(32);
        let task = tokio::spawn(accept_loop(
            listener,
            token.clone(),
            Arc::new(Shared::default()),
        ));
        let mut held = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            held.push(tokio::net::TcpStream::connect(addr).await.unwrap());
        }
        let mut extra = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut buf = [0u8; 1];
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            tokio::io::AsyncReadExt::read(&mut extra, &mut buf),
        )
        .await;
        assert!(
            matches!(read, Ok(Ok(0)) | Ok(Err(_))),
            "the connection past the cap is closed: {read:?}"
        );
        task.abort();
    }

    #[tokio::test]
    async fn remote_frames_wait_for_an_ack_and_skip_to_the_latest() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (push, mut queue) = tokio::sync::mpsc::unbounded_channel::<u8>();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut frames = futures_util::stream::poll_fn(move |cx| queue.poll_recv(cx));
            send_acked(ws, &mut frames, |n| vec![n]).await;
        });
        let (mut client, _) = tokio_tungstenite::connect_async(url).await.unwrap();

        push.send(1).unwrap();
        assert_eq!(recv(&mut client).await, Some(vec![1]));
        push.send(2).unwrap();
        push.send(3).unwrap();
        assert_eq!(
            recv(&mut client).await,
            None,
            "sent before the renderer acked"
        );
        client
            .send(Message::Binary(Vec::new().into()))
            .await
            .unwrap();
        assert_eq!(recv(&mut client).await, Some(vec![3]));
        server.abort();
    }

    impl FrameSize for (u32, u32) {
        fn frame_size(&self) -> (u32, u32) {
            *self
        }
    }

    #[tokio::test]
    async fn received_frames_past_the_ceiling_are_skipped_in_order() {
        let (push, mut queue) = tokio::sync::mpsc::unbounded_channel::<(u32, u32)>();
        let source = futures_util::stream::poll_fn(move |cx| queue.poll_recv(cx));
        let mut fitting = Fitting {
            inner: source,
            logged: false,
        };
        let max = owncord_parse::voice::REMOTE_FRAME_MAX_SIDE;
        for item in [
            (1280, 720),
            (max + 1, 2),
            (0, 720),
            (1920, 1080),
            (8192, 8192),
            (640, 360),
        ] {
            push.send(item).unwrap();
        }
        drop(push);

        let mut passed = Vec::new();
        while let Some(item) = fitting.next().await {
            passed.push(item);
        }
        assert_eq!(passed, vec![(1280, 720), (1920, 1080), (640, 360)]);
        assert!(fitting.logged, "the first skipped frame is logged");
    }

    #[tokio::test]
    async fn the_fitting_stream_ends_when_its_source_ends_after_a_skipped_frame() {
        let (push, mut queue) = tokio::sync::mpsc::unbounded_channel::<(u32, u32)>();
        let source = futures_util::stream::poll_fn(move |cx| queue.poll_recv(cx));
        let mut fitting = Fitting {
            inner: source,
            logged: false,
        };
        push.send((100_000, 2)).unwrap();
        drop(push);
        let next = tokio::time::timeout(std::time::Duration::from_secs(1), fitting.next()).await;
        assert_eq!(next, Ok(None), "the stream ends instead of waiting");
    }

    #[test]
    fn previews_fit_the_tile_size_and_keep_their_shape() {
        assert_eq!(preview_size((3840, 2160)), (1280, 720));
        assert_eq!(preview_size((2560, 1440)), (1280, 720));
        assert_eq!(preview_size((1920, 1080)), (1280, 720));
        assert_eq!(preview_size((3440, 1440)), (1280, 534));
        assert_eq!(preview_size((1080, 1920)), (404, 720));
        assert_eq!(preview_size((1280, 720)), (1280, 720));
        assert_eq!(preview_size((640, 480)), (640, 480));
        assert_eq!(preview_size((100_000, 2)), (1280, 2));
    }

    fn frame_size(data: &[u8]) -> (u32, u32) {
        let word = |at: usize| u32::from_le_bytes(data[at..at + 4].try_into().unwrap());
        (word(0), word(4))
    }

    #[tokio::test]
    async fn previews_are_scaled_and_sent_at_most_30_times_a_second() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (preview, frames) = tokio::sync::watch::channel(None);
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            send_preview(ws, frames).await;
        });
        let (mut client, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let frame = |w, h| Some(Arc::new(I420Buffer::new_black(w, h)));

        // A small first frame, so the interval is not met by the work of
        // sending it.
        let first_sent = std::time::Instant::now();
        preview.send_replace(frame(320, 180));
        let first = recv(&mut client).await.expect("the first preview frame");
        assert_eq!(frame_size(&first), (320, 180));
        client
            .send(Message::Binary(Vec::new().into()))
            .await
            .unwrap();
        preview.send_replace(frame(640, 360));
        preview.send_replace(frame(1920, 1080));
        let next = recv(&mut client).await.expect("the next preview frame");
        assert!(
            first_sent.elapsed() >= PREVIEW_INTERVAL,
            "the next frame waited out the interval: {:?}",
            first_sent.elapsed()
        );
        assert_eq!(frame_size(&next), (1280, 720), "the newest frame, scaled");
        assert_eq!(next.len(), 8 + 1280 * 720 * 3 / 2);
        server.abort();
    }

    #[test]
    fn tokens_are_256_bit_and_unique() {
        let a = random_token().unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, random_token().unwrap());
    }
}
