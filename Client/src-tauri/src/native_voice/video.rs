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
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use livekit::prelude::*;
use livekit::webrtc::prelude::{I420Buffer, VideoBuffer};
use livekit::webrtc::video_stream::native::NativeVideoStream;
use ring::rand::{SecureRandom, SystemRandom};
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use super::screen::Preview;

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
        *self.shared.camera.lock().unwrap_or_else(|p| p.into_inner()) = preview;
    }

    pub fn set_screen(&self, preview: Option<Arc<Preview>>) {
        *self.shared.screen.lock().unwrap_or_else(|p| p.into_inner()) = preview;
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
        let mut remote = self.0.remote.lock().unwrap_or_else(|p| p.into_inner());
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

async fn accept_loop(listener: TcpListener, token: String, shared: Arc<Shared>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    connections.spawn(serve(stream, token.clone(), shared.clone()));
                }
                Err(e) => {
                    log::warn!("[native_voice] frame socket accept: {e}");
                    return;
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
    let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, authorize).await else {
        log::debug!("[native_voice] frame socket handshake refused");
        return;
    };
    let Some(route) = chosen else { return };
    shared.sockets.fetch_add(1, Ordering::Relaxed);
    let _counted = Counted(shared.clone());
    match route {
        Route::Remote(sid) => {
            let track = shared
                .remote
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&sid)
                .cloned();
            match track {
                Some(track) => send_remote(ws, track).await,
                None => log::debug!("[native_voice] frame socket: no subscribed video {sid}"),
            }
        }
        Route::Camera => {
            let preview = shared
                .camera
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
                .map(|p| p.subscribe());
            match preview {
                Some(preview) => send_preview(ws, preview).await,
                None => log::debug!("[native_voice] frame socket: no camera capture"),
            }
        }
        Route::Screen => {
            let preview = shared
                .screen
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
                .map(|p| p.subscribe());
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
    send_acked(ws, &mut frames, |frame| pack_i420(&frame.buffer.to_i420())).await;
    frames.close();
}

async fn send_preview(ws: Ws, preview: tokio::sync::watch::Receiver<Option<Arc<I420Buffer>>>) {
    // Ends when the capture drops its sender.
    let mut frames = Box::pin(futures_util::stream::unfold(preview, |mut rx| async move {
        rx.changed().await.ok()?;
        let frame = rx.borrow_and_update().clone();
        Some((frame, rx))
    }));
    send_acked(ws, &mut frames, |frame| {
        frame.map(|f| pack_i420(&f)).unwrap_or_default()
    })
    .await;
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

    #[test]
    fn tokens_are_256_bit_and_unique() {
        let a = random_token().unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, random_token().unwrap());
    }
}
