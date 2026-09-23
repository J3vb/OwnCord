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
//! - `/<token>/camera`: the local camera, webview to server, as
//!   [`parse_upload`] messages fed to the published camera source.
//! - `/<token>/screen`: the local screen capture's preview, server to
//!   webview, acknowledged like a remote track; it ends with the capture.
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::{SinkExt, StreamExt};
use livekit::prelude::*;
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::prelude::{I420Buffer, VideoBuffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use ring::rand::{SecureRandom, SystemRandom};
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use super::screen::Preview;

/// Pixel layouts the webview can upload, as `VideoFrame.format` names them.
/// RGBX/BGRX share the alpha layouts (the alpha byte is ignored).
const FORMAT_RGBA: u32 = 1;
const FORMAT_BGRA: u32 = 2;
const FORMAT_I420: u32 = 3;
const FORMAT_NV12: u32 = 4;

/// Upload header: format, width, height, then (offset, stride) for up to
/// three planes, all little-endian u32.
const UPLOAD_HEADER: usize = 9 * 4;

/// Largest frame either direction accepts (4K); bounds the allocation a
/// malformed header can request.
const MAX_DIMENSION: u32 = 4096;

/// State the connection tasks share with the session.
#[derive(Default)]
struct Shared {
    /// Subscribed remote video tracks by sid, kept current from the room's
    /// events before they reach the webview.
    remote: Mutex<HashMap<String, RemoteVideoTrack>>,
    /// The published camera's source; `None` while no camera is published.
    camera: Mutex<Option<NativeVideoSource>>,
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

    pub fn set_camera(&self, source: Option<NativeVideoSource>) {
        *self.shared.camera.lock().unwrap_or_else(|p| p.into_inner()) = source;
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
        Route::Camera => receive_camera(ws, &shared).await,
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

async fn send_preview(ws: Ws, preview: tokio::sync::watch::Receiver<Option<Arc<Vec<u8>>>>) {
    // Ends when the capture drops its sender.
    let mut frames = Box::pin(futures_util::stream::unfold(preview, |mut rx| async move {
        rx.changed().await.ok()?;
        let frame = rx.borrow_and_update().clone();
        Some((frame, rx))
    }));
    send_acked(ws, &mut frames, |frame| {
        frame.map(|f| f.as_ref().clone()).unwrap_or_default()
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

async fn receive_camera(ws: Ws, shared: &Shared) {
    let (_tx, mut rx) = ws.split();
    let started = Instant::now();
    while let Some(Ok(msg)) = rx.next().await {
        let Message::Binary(data) = msg else {
            if matches!(msg, Message::Close(_)) {
                break;
            }
            continue;
        };
        let Some(source) = shared
            .camera
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        else {
            break;
        };
        match parse_upload(&data) {
            Ok(buffer) => {
                source.capture_frame(&VideoFrame {
                    rotation: VideoRotation::VideoRotation0,
                    timestamp_us: started.elapsed().as_micros() as i64,
                    frame_metadata: None,
                    buffer,
                });
            }
            Err(e) => log::warn!("[native_voice] camera frame dropped: {e}"),
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

fn u32_at(data: &[u8], index: usize) -> u32 {
    let at = index * 4;
    u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

/// One plane of an upload, bounds-checked against the message: libyuv only
/// asserts `stride * rows`, so a short stride would read past the buffer.
fn plane(data: &[u8], index: usize, row_bytes: usize, rows: usize) -> Result<(&[u8], u32), String> {
    let offset = u32_at(data, 3 + index * 2) as usize;
    let stride = u32_at(data, 4 + index * 2) as usize;
    let body = &data[UPLOAD_HEADER..];
    if stride < row_bytes || offset.saturating_add(stride.saturating_mul(rows)) > body.len() {
        return Err(format!("plane {index} out of bounds"));
    }
    Ok((&body[offset..offset + stride * rows], stride as u32))
}

/// Convert one camera frame from the webview (`VideoFrame.copyTo` output,
/// described by the header) to the I420 the encoder takes.
pub fn parse_upload(data: &[u8]) -> Result<I420Buffer, String> {
    if data.len() < UPLOAD_HEADER {
        return Err("short camera frame".into());
    }
    let (format, width, height) = (u32_at(data, 0), u32_at(data, 1), u32_at(data, 2));
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(format!("bad camera frame size {width}x{height}"));
    }
    let (w, h) = (width as usize, height as usize);
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    let mut out = I420Buffer::new(width, height);
    let (dsy, dsu, dsv) = out.strides();
    let (dy, du, dv) = out.data_mut();
    let (iw, ih) = (width as i32, height as i32);
    match format {
        FORMAT_RGBA | FORMAT_BGRA => {
            let (src, stride) = plane(data, 0, w * 4, h)?;
            // libyuv names by word order: its "ABGR" is R,G,B,A in memory.
            let convert = if format == FORMAT_RGBA {
                yuv_helper::abgr_to_i420
            } else {
                yuv_helper::argb_to_i420
            };
            convert(src, stride, dy, dsy, du, dsu, dv, dsv, iw, ih);
        }
        FORMAT_I420 => {
            let planes = [
                (plane(data, 0, w, h)?, dy, dsy, w, h),
                (plane(data, 1, cw, ch)?, du, dsu, cw, ch),
                (plane(data, 2, cw, ch)?, dv, dsv, cw, ch),
            ];
            for ((src, stride), dst, dst_stride, row_bytes, rows) in planes {
                for row in 0..rows {
                    let s = row * stride as usize;
                    let d = row * dst_stride as usize;
                    dst[d..d + row_bytes].copy_from_slice(&src[s..s + row_bytes]);
                }
            }
        }
        FORMAT_NV12 => {
            let (y, sy) = plane(data, 0, w, h)?;
            let (uv, suv) = plane(data, 1, cw * 2, ch)?;
            yuv_helper::nv12_to_i420(y, sy, uv, suv, dy, dsy, du, dsu, dv, dsv, iw, ih);
        }
        other => return Err(format!("unsupported camera frame format {other}")),
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upload(format: u32, w: u32, h: u32, planes: &[(u32, u32)], body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for v in [format, w, h] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for i in 0..3 {
            let (offset, stride) = planes.get(i).copied().unwrap_or_default();
            out.extend_from_slice(&offset.to_le_bytes());
            out.extend_from_slice(&stride.to_le_bytes());
        }
        out.extend_from_slice(body);
        out
    }

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

    #[test]
    fn a_white_rgba_frame_becomes_white_i420() {
        let (w, h) = (4u32, 2u32);
        let body = vec![255u8; (w * h * 4) as usize];
        let i420 = parse_upload(&upload(FORMAT_RGBA, w, h, &[(0, w * 4)], &body)).unwrap();
        let (y, u, v) = i420.data();
        assert!(y[..8].iter().all(|&p| p >= 234), "luma {:?}", &y[..8]);
        assert!(u[..2]
            .iter()
            .chain(&v[..2])
            .all(|&p| (126..=130).contains(&p)));
    }

    #[test]
    fn i420_uploads_honour_strides_and_pack_back_tightly() {
        // 4x2 with a Y stride of 6: the padding bytes (9) must not leak in.
        let body = [
            1, 2, 3, 4, 9, 9, 5, 6, 7, 8, 9, 9, // Y
            10, 11, // U (stride 2)
            20, 21, // V
        ];
        let frame = upload(FORMAT_I420, 4, 2, &[(0, 6), (12, 2), (14, 2)], &body);
        let packed = pack_i420(&parse_upload(&frame).unwrap());
        assert_eq!(&packed[..8], &[4, 0, 0, 0, 2, 0, 0, 0]);
        assert_eq!(&packed[8..], &[1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 20, 21]);
    }

    #[test]
    fn nv12_uploads_deinterleave_chroma() {
        let body = [1, 2, 3, 4, 5, 6, 7, 8, 10, 20, 11, 21];
        let frame = upload(FORMAT_NV12, 4, 2, &[(0, 4), (8, 4)], &body);
        let packed = pack_i420(&parse_upload(&frame).unwrap());
        assert_eq!(&packed[8..], &[1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 20, 21]);
    }

    #[test]
    fn malformed_uploads_are_rejected_not_read_out_of_bounds() {
        assert!(parse_upload(&[0; 8]).is_err());
        // Stride shorter than a row.
        assert!(parse_upload(&upload(FORMAT_RGBA, 4, 2, &[(0, 8)], &[0; 32])).is_err());
        // Body shorter than stride * rows.
        assert!(parse_upload(&upload(FORMAT_RGBA, 4, 2, &[(0, 16)], &[0; 31])).is_err());
        // Offset past the end.
        assert!(parse_upload(&upload(
            FORMAT_I420,
            2,
            2,
            &[(99, 2), (0, 1), (0, 1)],
            &[0; 6]
        ))
        .is_err());
        assert!(parse_upload(&upload(FORMAT_RGBA, 0, 2, &[(0, 0)], &[])).is_err());
        assert!(parse_upload(&upload(FORMAT_RGBA, 8192, 2, &[(0, 32768)], &[])).is_err());
        assert!(parse_upload(&upload(99, 2, 2, &[(0, 8)], &[0; 16])).is_err());
    }
}
