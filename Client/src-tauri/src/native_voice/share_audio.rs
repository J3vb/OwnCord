//! Screen-share audio capture on Linux: every other application's sound.
//!
//! A sink's monitor carries the finished mix, OwnCord's own call included, and
//! cannot be cleaned afterwards. So this records each application's stream on
//! the default output separately, through the PulseAudio protocol's "record
//! directly on a sink input" request (`direct_on_input_index`), skips
//! OwnCord's own streams, mixes the rest to 10 ms of 48 kHz stereo and hands
//! that to the screen-share audio track's source. The protocol is the same on
//! PulseAudio and on pipewire-pulse. A share of one X11 window records only
//! that window's application (its process and every descendant), as Windows
//! does; anything else records every other application.
//!
//! The `pulseaudio` crate's high-level `Client` cannot list sink inputs and
//! its reactor thread is never joined, so one thread here drives one socket
//! through the crate's public `protocol` module. It owns everything: the
//! socket, the per-stream queues (`playout::Mixer`) and the 10 ms clock that
//! paces the source. A tick with nothing to mix sends silence, so the track
//! keeps flowing while no application plays, while the sound server restarts
//! and while it is unreachable.
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CStr, CString};
use std::io::{self, Cursor, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use pulseaudio::protocol::{
    self, AuthParams, AuthReply, ChannelMap, ChannelVolume, ClientInfo, ClientInfoList, Command,
    CommandReply, CreateRecordStreamReply, Prop, Props, PulseError, RecordStreamParams,
    SampleFormat, SampleSpec, ServerInfo, SetClientNameReply, SinkInfoList, SinkInputInfo,
    SinkInputInfoList,
};

use pulseaudio::protocol::stream::{BufferAttr, StreamFlags};

use super::playout::{Mixer, FOLLOW_EVERY};

const RATE: u32 = 48_000;
/// One 10 ms frame, per channel.
const FRAME: usize = RATE as usize / 100;
const TICK: Duration = Duration::from_millis(10);
/// A clock this far behind (a stalled thread) restarts instead of catching up
/// with a burst of frames.
const MAX_LAG: Duration = Duration::from_millis(100);
/// How often the sink inputs are listed, so a newly started application is
/// recorded within a second.
const POLL_EVERY: Duration = Duration::from_secs(1);
/// `available()` and the handshake of a (re)connect.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(500);
/// A blocked write gives up after this, so a hung server cannot hold a stop.
const WRITE_TIMEOUT: Duration = Duration::from_millis(250);
/// A request on a connected socket.
const REPLY_TIMEOUT: Duration = Duration::from_secs(2);
/// The name cpal gives every PulseAudio connection it opens: `cpal-pulseaudio-`
/// and our pid (cpal-0.18.2 `src/host/pulseaudio/mod.rs`, `Host::new`).
/// Playout, app sounds and the mic test all play through cpal hosts. A cpal
/// bump that renames this reintroduces the echo; the ignored real-server test
/// catches that. On pipewire-pulse the cpal client's `application.process.id`
/// is the daemon's pid, not ours, so this name prefix is the only thing that
/// excludes our own playout there.
const CPAL_CLIENT_PREFIX: &str = "cpal-pulseaudio-";
/// The channel of a control packet.
const CONTROL: u32 = u32::MAX;
/// Property pipewire-pulse sets on a client. For a native PipeWire client it is
/// the real pid; for a pulse client it is the daemon's own.
const PIPEWIRE_SEC_PID: &CStr = c"pipewire.sec.pid";

// ---- who is ours, which streams count -----------------------------------

/// What identifies OwnCord's own playback on the sound server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Own {
    pid: u32,
    /// Our pid and every candidate pid found to descend from it.
    tree: BTreeSet<u32>,
}

impl Own {
    pub(super) fn new(pid: u32, tree: BTreeSet<u32>) -> Self {
        let mut tree = tree;
        tree.insert(pid);
        Self { pid, tree }
    }

    fn client_name(&self, name: &str) -> bool {
        // `cpal-pulseaudio-123` is ours as pid 123, not as pid 12.
        name.strip_prefix(CPAL_CLIENT_PREFIX)
            .and_then(|rest| rest.strip_prefix(self.pid.to_string().as_str()))
            .is_some_and(|rest| !rest.starts_with(|c: char| c.is_ascii_digit()))
    }
}

fn prop_pid(props: &Props, key: &CStr) -> Option<u32> {
    let bytes = props.get_bytes(key)?;
    let text = std::str::from_utf8(bytes).ok()?;
    text.trim_end_matches('\0').trim().parse().ok()
}

/// The pids a stream or its client claims, in the order the server is most
/// truthful: a pulse-protocol client carries its real pid as
/// `application.process.id` (its `pipewire.sec.pid` is the pipewire-pulse
/// daemon's), a native PipeWire client has only `pipewire.sec.pid` on its
/// client.
fn claimed_pids(input: &SinkInputInfo, client: Option<&ClientInfo>) -> Vec<u32> {
    let app = |p: &Props| prop_pid(p, c"application.process.id");
    [
        app(&input.props),
        client.and_then(|c| app(&c.props)),
        client.and_then(|c| prop_pid(&c.props, PIPEWIRE_SEC_PID)),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn client_of<'a>(input: &SinkInputInfo, clients: &'a [ClientInfo]) -> Option<&'a ClientInfo> {
    let index = input.client_index?;
    clients.iter().find(|c| c.index == index)
}

/// Whether `input` is OwnCord's own playback: a client named like cpal's for
/// our pid, or a pid claimed by the stream or its client that is ours or one
/// of our descendants (the WebKit web process plays page audio on its own).
/// The daemon's pid can never be in our tree, so it can only fail to match.
/// Any OwnCord descendant is excluded, as Windows excludes the whole process
/// tree.
pub(super) fn is_own(input: &SinkInputInfo, clients: &[ClientInfo], own: &Own) -> bool {
    let client = client_of(input, clients);
    if client.is_some_and(|c| own.client_name(&c.name.to_string_lossy())) {
        return true;
    }
    claimed_pids(input, client)
        .iter()
        .any(|pid| own.tree.contains(pid))
}

/// Whether a pid the stream or its client claims is in `app`, the shared
/// window's process and its descendants (a browser plays from a child).
fn is_app(input: &SinkInputInfo, clients: &[ClientInfo], app: &BTreeSet<u32>) -> bool {
    claimed_pids(input, client_of(input, clients))
        .iter()
        .any(|pid| app.contains(pid))
}

/// The sink inputs to record: on the default sink (filter outputs such as
/// echo-cancel and combine sinks sit on the hardware sink and already hold
/// every application, OwnCord included), not muted, not ours, and, when
/// `app` is given, only that application's.
pub(super) fn wanted(
    inputs: &[SinkInputInfo],
    default_sink: Option<u32>,
    clients: &[ClientInfo],
    own: &Own,
    app: Option<&BTreeSet<u32>>,
) -> BTreeSet<u32> {
    let Some(default_sink) = default_sink else {
        return BTreeSet::new();
    };
    inputs
        .iter()
        .filter(|i| i.sink_index == default_sink && !i.muted && !is_own(i, clients, own))
        .filter(|i| app.is_none_or(|app| is_app(i, clients, app)))
        .map(|i| i.index)
        .collect()
}

/// `candidates` that are `own_pid` or have it among their ancestors.
pub(super) fn descendants(
    own_pid: u32,
    candidates: impl IntoIterator<Item = u32>,
    parent_of: impl Fn(u32) -> Option<u32>,
) -> BTreeSet<u32> {
    let mut tree = BTreeSet::from([own_pid]);
    for candidate in candidates {
        let mut pid = candidate;
        for _ in 0..64 {
            if pid == own_pid {
                tree.insert(candidate);
                break;
            }
            match parent_of(pid) {
                Some(parent) if parent > 1 => pid = parent,
                _ => break,
            }
        }
    }
    tree
}

/// A process's parent, from `/proc/<pid>/stat` (the name field may hold
/// spaces and parentheses, so the fields count from its last `)`).
fn proc_parent(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(1)?.parse().ok()
}

fn resolve_own(inputs: &[SinkInputInfo], clients: &[ClientInfo]) -> Own {
    let pid = std::process::id();
    Own::new(pid, resolve_tree(pid, inputs, clients))
}

/// `pid` and every pid the streams claim that descends from it.
fn resolve_tree(pid: u32, inputs: &[SinkInputInfo], clients: &[ClientInfo]) -> BTreeSet<u32> {
    let candidates = inputs
        .iter()
        .flat_map(|i| claimed_pids(i, client_of(i, clients)));
    descendants(pid, candidates, proc_parent)
}

// ---- the socket ----------------------------------------------------------

/// Where the sound server listens, in libpulse's order: a `unix:` entry of
/// `PULSE_SERVER`, then `$PULSE_RUNTIME_PATH/native`, then
/// `$XDG_RUNTIME_DIR/pulse/native`. A `PULSE_SERVER` that names only remote
/// servers means the local socket is not the one in use: `None`, "no server".
/// A local entry of PulseAudio's server string: `unix:/path` or a bare
/// `/path`, either optionally prefixed by `{machine-id}`. Remote entries
/// (`tcp:`, `host`, ...) give `None`.
fn local_server_path(entry: &str) -> Option<PathBuf> {
    let entry = match entry.strip_prefix('{') {
        Some(rest) => rest.split_once('}')?.1,
        None => entry,
    };
    let path = entry.strip_prefix("unix:").unwrap_or(entry);
    path.starts_with('/').then(|| PathBuf::from(path))
}

fn socket_path_in(
    pulse_server: Option<&str>,
    pulse_runtime_path: Option<&str>,
    xdg_runtime_dir: Option<&str>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let named: Vec<PathBuf> = pulse_server
        .into_iter()
        .flat_map(str::split_whitespace)
        .filter_map(local_server_path)
        .collect();
    if named.is_empty() && pulse_server.is_some_and(|s| !s.trim().is_empty()) {
        return None;
    }
    let runtime = pulse_runtime_path.map(|dir| Path::new(dir).join("native"));
    let xdg = xdg_runtime_dir.map(|dir| Path::new(dir).join("pulse/native"));
    named
        .into_iter()
        .chain(runtime)
        .chain(xdg)
        .find(|p| exists(p))
}

fn socket_path() -> Option<PathBuf> {
    socket_path_in(
        std::env::var("PULSE_SERVER").ok().as_deref(),
        std::env::var("PULSE_RUNTIME_PATH").ok().as_deref(),
        std::env::var("XDG_RUNTIME_DIR").ok().as_deref(),
        |p| p.exists(),
    )
}

fn connect_server() -> io::Result<UnixStream> {
    let path =
        socket_path().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no sound server"))?;
    UnixStream::connect(path)
}

/// Why a request failed: the server said no (the connection is fine), or the
/// connection is not.
#[derive(Debug)]
enum Fail {
    Refused(String),
    Io(io::Error),
}

impl From<io::Error> for Fail {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

fn into_io(e: protocol::ProtocolError) -> io::Error {
    match e {
        protocol::ProtocolError::Io(e) => e,
        other => io::Error::new(io::ErrorKind::InvalidData, other),
    }
}

/// One packet: its channel and the raw bytes (descriptor included, which is
/// what the crate's reply readers want).
struct Frame {
    channel: u32,
    raw: Vec<u8>,
}

impl Frame {
    fn payload(&self) -> &[u8] {
        &self.raw[protocol::DESCRIPTOR_SIZE..]
    }

    /// The sequence number and command of a control packet; a `Reply` has
    /// not had its payload read. Unparseable packets are skipped, not fatal:
    /// the framing is intact.
    fn control(&self, version: u16) -> Option<(u32, Command)> {
        if self.channel != CONTROL {
            return None;
        }
        Command::read_tag_prefixed(&mut Cursor::new(self.payload()), version).ok()
    }

    fn decode<T: CommandReply>(&self, version: u16) -> Result<T, Fail> {
        protocol::read_reply_message::<T>(&mut Cursor::new(&self.raw[..]), version)
            .map(|(_, reply)| reply)
            .map_err(|e| match e {
                protocol::ProtocolError::ServerError(e) => Fail::Refused(e.to_string()),
                other => Fail::Io(into_io(other)),
            })
    }
}

/// A framed, timed view of the socket: read timeouts are the clock's sleep.
struct Conn {
    sock: UnixStream,
    buf: Vec<u8>,
    version: u16,
    seq: u32,
}

impl Conn {
    fn new(sock: UnixStream) -> io::Result<Self> {
        sock.set_write_timeout(Some(WRITE_TIMEOUT))?;
        Ok(Self {
            sock,
            buf: Vec::new(),
            version: protocol::MAX_VERSION,
            seq: 0,
        })
    }

    fn send(&mut self, command: &Command) -> io::Result<u32> {
        self.seq = self.seq.wrapping_add(1);
        let mut msg = Vec::new();
        protocol::write_command_message(&mut msg, self.seq, command, self.version)
            .map_err(into_io)?;
        self.sock.write_all(&msg)?;
        Ok(self.seq)
    }

    fn split(&mut self) -> io::Result<Option<Frame>> {
        let head = protocol::DESCRIPTOR_SIZE;
        if self.buf.len() < head {
            return Ok(None);
        }
        let desc = protocol::read_descriptor(&mut &self.buf[..head]).map_err(into_io)?;
        let len = desc.length as usize;
        if len > protocol::MAX_MEMBLOCKQ_LENGTH {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "oversized packet",
            ));
        }
        if self.buf.len() < head + len {
            return Ok(None);
        }
        let raw: Vec<u8> = self.buf.drain(..head + len).collect();
        Ok(Some(Frame {
            channel: desc.channel,
            raw,
        }))
    }

    /// The next packet, or `None` once `until` passes with none complete.
    fn frame(&mut self, until: Instant) -> io::Result<Option<Frame>> {
        let mut chunk = [0u8; 16 * 1024];
        loop {
            if let Some(frame) = self.split()? {
                return Ok(Some(frame));
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(None);
            }
            // A zero timeout means "forever" to the OS, hence the 1 ms floor.
            self.sock
                .set_read_timeout(Some(left.max(Duration::from_millis(1))))?;
            match self.sock.read(&mut chunk) {
                Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                            | io::ErrorKind::Interrupted
                    ) => {}
                Err(e) => return Err(e),
            }
        }
    }
}

/// Whether a PulseAudio-protocol server (PulseAudio or pipewire-pulse) answers
/// the handshake within 500 ms.
pub fn available() -> bool {
    let attempt = || -> Result<(), Fail> {
        let sock = connect_server()?;
        let stop = AtomicBool::new(false);
        let app = AtomicU32::new(0);
        let mut deliver = |_: &[i16]| {};
        let mut out = Out::new(&mut deliver, &stop, &app);
        Link::open(sock, &mut out).map(drop)
    };
    attempt().is_ok()
}

// ---- the capture thread --------------------------------------------------

/// The 10 ms schedule. It runs on an `Instant` deadline so it does not drift.
struct Ticker {
    next: Instant,
}

impl Ticker {
    fn due(&mut self, now: Instant) -> bool {
        if now < self.next {
            return false;
        }
        self.next += TICK;
        if now > self.next + MAX_LAG {
            self.next = now + TICK;
        }
        true
    }
}

/// What survives a reconnect: the mixer, the clock and the output.
struct Out<'a> {
    mixer: Mixer,
    ticker: Ticker,
    deliver: &'a mut dyn FnMut(&[i16]),
    stop: &'a AtomicBool,
    /// The shared window's process, 0 for every application.
    app: &'a AtomicU32,
    mixed: Vec<f32>,
    pcm: Vec<i16>,
}

impl<'a> Out<'a> {
    fn new(deliver: &'a mut dyn FnMut(&[i16]), stop: &'a AtomicBool, app: &'a AtomicU32) -> Self {
        Self {
            mixer: Mixer::default(),
            ticker: Ticker {
                next: Instant::now() + TICK,
            },
            deliver,
            stop,
            app,
            mixed: vec![0.0; FRAME * 2],
            pcm: Vec::with_capacity(FRAME * 2),
        }
    }
}

impl Out<'_> {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }

    /// Deliver every tick that is due: 10 ms of the mix, or silence.
    fn pump(&mut self) {
        while self.ticker.due(Instant::now()) {
            self.mixer.mix(&mut self.mixed, 2);
            self.pcm.clear();
            self.pcm
                .extend(self.mixed.iter().map(|s| (s * 32767.0).round() as i16));
            (self.deliver)(&self.pcm);
        }
    }

    /// Keep the clock running with nothing to mix, for `span` or until stopped.
    fn idle(&mut self, span: Duration) {
        let end = Instant::now() + span;
        while !self.stopped() {
            self.pump();
            let now = Instant::now();
            if now >= end {
                return;
            }
            thread::sleep(self.ticker.next.min(end).saturating_duration_since(now));
        }
    }
}

struct Stream {
    channel: u32,
    sid: String,
    /// Bytes of a frame split across packets.
    carry: Vec<u8>,
}

/// One connection's state.
struct Link {
    conn: Conn,
    /// Recorded sink inputs by index.
    streams: BTreeMap<u32, Stream>,
    by_channel: BTreeMap<u32, u32>,
    /// Inputs a create was refused for: logged once while they stay listed.
    refused: BTreeSet<u32>,
}

fn record_params(input: u32) -> RecordStreamParams {
    let mut props = Props::new();
    props.set(Prop::MediaName, c"OwnCord screen share audio");
    RecordStreamParams {
        sample_spec: SampleSpec {
            format: SampleFormat::S16Le,
            channels: 2,
            sample_rate: RATE,
        },
        channel_map: ChannelMap::stereo(),
        buffer_attr: BufferAttr {
            fragment_size: (FRAME * 2 * 2) as u32,
            ..Default::default()
        },
        flags: StreamFlags {
            adjust_latency: true,
            no_move: true,
            ..Default::default()
        },
        direct_on_input_index: Some(input),
        cvolume: Some(ChannelVolume::norm(2)),
        props,
        ..Default::default()
    }
}

impl Link {
    /// Connect and handshake: Auth, then name this client, within one
    /// deadline for both. Ticks keep running and a stop is noticed meanwhile.
    fn open(sock: UnixStream, out: &mut Out<'_>) -> Result<Self, Fail> {
        let mut link = Self {
            conn: Conn::new(sock)?,
            streams: BTreeMap::new(),
            by_channel: BTreeMap::new(),
            refused: BTreeSet::new(),
        };
        let until = Instant::now() + HANDSHAKE_TIMEOUT;
        let cookie = pulseaudio::cookie_path_from_env()
            .and_then(|path| std::fs::read(path).ok())
            .unwrap_or_default();
        let auth = AuthParams {
            version: protocol::MAX_VERSION,
            supports_shm: false,
            supports_memfd: false,
            cookie,
        };
        let reply: AuthReply = link.request_until(out, &Command::Auth(auth), until)?;
        link.conn.version = reply.version.min(protocol::MAX_VERSION);
        let mut props = Props::new();
        props.set(Prop::ApplicationName, c"OwnCord screen share audio");
        if let Ok(pid) = CString::new(std::process::id().to_string()) {
            props.set(Prop::ApplicationProcessId, pid);
        }
        let _: SetClientNameReply =
            link.request_until(out, &Command::SetClientName(props), until)?;
        Ok(link)
    }

    /// Drop every queue; the socket closes with the link.
    fn close(&mut self, out: &Out<'_>) {
        for stream in self.streams.values() {
            out.mixer.remove(&stream.sid);
        }
        self.streams.clear();
        self.by_channel.clear();
    }

    fn forget(&mut self, out: &Out<'_>, input: u32) {
        if let Some(stream) = self.streams.remove(&input) {
            self.by_channel.remove(&stream.channel);
            out.mixer.remove(&stream.sid);
        }
    }

    /// One wait for a packet, at most until the next tick, with every due tick
    /// delivered either side of it. Stream data is queued here; a control
    /// packet is returned.
    fn step(&mut self, out: &mut Out<'_>) -> io::Result<Option<Frame>> {
        out.pump();
        let frame = self.conn.frame(out.ticker.next)?;
        out.pump();
        let Some(frame) = frame else {
            return Ok(None);
        };
        if frame.channel == CONTROL {
            return Ok(Some(frame));
        }
        self.on_data(out, &frame);
        Ok(None)
    }

    fn on_data(&mut self, out: &Out<'_>, frame: &Frame) {
        let Some(stream) = self
            .by_channel
            .get(&frame.channel)
            .and_then(|input| self.streams.get_mut(input))
        else {
            return;
        };
        stream.carry.extend_from_slice(frame.payload());
        let whole = stream.carry.len() / 4 * 4;
        let samples: Vec<i16> = stream.carry[..whole]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| i16::from_le_bytes(*b))
            .collect();
        stream.carry.drain(..whole);
        out.mixer.push(&stream.sid, &samples);
    }

    fn on_control(&mut self, out: &Out<'_>, command: &Command) {
        if let Command::RecordStreamKilled(channel) = command {
            // Recreated by the next poll if the input is still wanted.
            if let Some(input) = self.by_channel.get(channel).copied() {
                self.forget(out, input);
            }
        }
    }

    fn request<T: CommandReply>(
        &mut self,
        out: &mut Out<'_>,
        command: &Command,
    ) -> Result<T, Fail> {
        self.request_until(out, command, Instant::now() + REPLY_TIMEOUT)
    }

    fn request_until<T: CommandReply>(
        &mut self,
        out: &mut Out<'_>,
        command: &Command,
        until: Instant,
    ) -> Result<T, Fail> {
        let seq = self.conn.send(command)?;
        loop {
            if out.stopped() {
                return Err(io::Error::from(io::ErrorKind::Interrupted).into());
            }
            if Instant::now() >= until {
                return Err(io::Error::from(io::ErrorKind::TimedOut).into());
            }
            let Some(frame) = self.step(out)? else {
                continue;
            };
            match frame.control(self.conn.version) {
                Some((s, Command::Reply)) if s == seq => return frame.decode(self.conn.version),
                Some((s, Command::Error(e))) if s == seq => return Err(refused(e)),
                Some((_, other)) => self.on_control(out, &other),
                None => {}
            }
        }
    }

    /// List the server and bring the recorded streams in line.
    fn poll(&mut self, out: &mut Out<'_>) -> Result<(), Fail> {
        let server: ServerInfo = self.request(out, &Command::GetServerInfo)?;
        let sinks: SinkInfoList = self.request(out, &Command::GetSinkInfoList)?;
        // The default is a name; sink inputs carry an index.
        let default_sink = server
            .default_sink_name
            .as_ref()
            .and_then(|name| sinks.iter().find(|s| &s.name == name))
            .map(|s| s.index);
        let inputs: SinkInputInfoList = self.request(out, &Command::GetSinkInputInfoList)?;
        let clients: ClientInfoList = self.request(out, &Command::GetClientInfoList)?;
        let app = match out.app.load(Ordering::Acquire) {
            0 => None,
            pid => Some(resolve_tree(pid, &inputs, &clients)),
        };
        let want = wanted(
            &inputs,
            default_sink,
            &clients,
            &resolve_own(&inputs, &clients),
            app.as_ref(),
        );
        self.reconcile(out, &want)
    }

    fn reconcile(&mut self, out: &mut Out<'_>, want: &BTreeSet<u32>) -> Result<(), Fail> {
        let gone: Vec<u32> = self
            .streams
            .keys()
            .filter(|i| !want.contains(i))
            .copied()
            .collect();
        for input in gone {
            if let Some(stream) = self.streams.get(&input) {
                self.conn
                    .send(&Command::DeleteRecordStream(stream.channel))?;
            }
            self.forget(out, input);
        }
        self.refused.retain(|i| want.contains(i));
        let missing: Vec<u32> = want
            .iter()
            .filter(|i| !self.streams.contains_key(i))
            .copied()
            .collect();
        for input in missing {
            match self.request::<CreateRecordStreamReply>(
                out,
                &Command::CreateRecordStream(record_params(input)),
            ) {
                Ok(reply) if reply.sample_spec == record_params(input).sample_spec => {
                    let sid = format!("share-audio-{input}");
                    out.mixer.add(&sid, &sid, None, 2);
                    self.by_channel.insert(reply.channel, input);
                    self.streams.insert(
                        input,
                        Stream {
                            channel: reply.channel,
                            sid,
                            carry: Vec::new(),
                        },
                    );
                }
                Ok(reply) => {
                    // A format we did not ask for would be misread as S16.
                    self.conn
                        .send(&Command::DeleteRecordStream(reply.channel))?;
                    self.note_refused(input, "unexpected sample format");
                }
                // The app quit between the list and the create, or the
                // server refuses direct recording of it.
                Err(Fail::Refused(why)) => self.note_refused(input, &why),
                Err(Fail::Io(e)) => return Err(Fail::Io(e)),
            }
        }
        Ok(())
    }

    fn note_refused(&mut self, input: u32, why: &str) {
        if self.refused.insert(input) {
            log::warn!("[native_voice] share audio: cannot record sink input {input}: {why}");
        }
    }

    /// Poll and pump until the socket fails or the owner stops us.
    fn serve(
        &mut self,
        out: &mut Out<'_>,
        timing: &Timing,
        inputs: &AtomicUsize,
    ) -> io::Result<()> {
        let mut next_poll = Instant::now();
        loop {
            if out.stopped() {
                return Ok(());
            }
            if Instant::now() >= next_poll {
                match self.poll(out) {
                    Ok(()) => {}
                    Err(Fail::Refused(why)) => {
                        log::debug!("[native_voice] share audio poll: {why}")
                    }
                    Err(Fail::Io(e)) => return Err(e),
                }
                inputs.store(self.streams.len(), Ordering::Release);
                next_poll = Instant::now() + timing.poll;
            }
            if let Some(frame) = self.step(out)? {
                if let Some((_, command)) = frame.control(self.conn.version) {
                    self.on_control(out, &command);
                }
            }
        }
    }
}

fn refused(e: PulseError) -> Fail {
    Fail::Refused(e.to_string())
}

#[derive(Clone, Copy)]
struct Timing {
    poll: Duration,
    reconnect: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            poll: POLL_EVERY,
            reconnect: FOLLOW_EVERY,
        }
    }
}

/// The thread body. `connect` opens the socket (again after a failure),
/// `deliver` takes each 10 ms of interleaved stereo, `inputs` publishes how
/// many streams are recorded. Returns once `stop` is set.
fn run(
    connect: impl FnMut() -> io::Result<UnixStream>,
    deliver: impl FnMut(&[i16]),
    stop: Arc<AtomicBool>,
    inputs: Arc<AtomicUsize>,
    app: Arc<AtomicU32>,
) {
    run_with(Timing::default(), connect, deliver, stop, inputs, app);
}

fn run_with(
    timing: Timing,
    mut connect: impl FnMut() -> io::Result<UnixStream>,
    mut deliver: impl FnMut(&[i16]),
    stop: Arc<AtomicBool>,
    inputs: Arc<AtomicUsize>,
    app: Arc<AtomicU32>,
) {
    let mut out = Out::new(&mut deliver, &stop, &app);
    // At most one warning a minute: a server that stays down or keeps sending
    // what we cannot parse must not fill the log every reconnect.
    let mut last_warn: Option<Instant> = None;
    let mut warn = |msg: String| {
        if last_warn.is_none_or(|t| t.elapsed() >= Duration::from_secs(60)) {
            last_warn = Some(Instant::now());
            log::warn!("[native_voice] share audio: {msg}");
        }
    };
    while !out.stopped() {
        let opened = connect()
            .map_err(Fail::from)
            .and_then(|sock| Link::open(sock, &mut out));
        match opened {
            Ok(mut link) => {
                let result = link.serve(&mut out, &timing, &inputs);
                link.close(&out);
                inputs.store(0, Ordering::Release);
                if let Err(e) = result {
                    if !out.stopped() {
                        warn(format!("sound server connection lost: {e}"));
                    }
                }
            }
            Err(why) => {
                if !out.stopped() {
                    warn(format!("sound server unavailable: {why:?}"));
                }
            }
        }
        out.idle(timing.reconnect);
    }
}

/// The running capture. Dropping it stops and joins the thread, which closes
/// the socket.
pub struct ShareAudio {
    stop: Arc<AtomicBool>,
    inputs: Arc<AtomicUsize>,
    app: Arc<AtomicU32>,
    thread: Option<JoinHandle<()>>,
}

impl ShareAudio {
    /// Start capturing into `source`: only application `app`'s sound (its
    /// process tree) when given, else every other application's. Returns at
    /// once; a missing or restarting sound server is retried on the thread,
    /// and the source gets silence meanwhile.
    pub fn start(source: NativeAudioSource, app: Option<u32>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let inputs = Arc::new(AtomicUsize::new(0));
        let app = Arc::new(AtomicU32::new(app.unwrap_or(0)));
        let (s, i, a) = (Arc::clone(&stop), Arc::clone(&inputs), Arc::clone(&app));
        let mut failed = false;
        let deliver = move |pcm: &[i16]| {
            // The source is unbuffered (queue 0), so this completes at once.
            let sent = source
                .capture_frame(&AudioFrame {
                    data: pcm.into(),
                    sample_rate: RATE,
                    num_channels: 2,
                    samples_per_channel: FRAME as u32,
                })
                .now_or_never();
            if let Some(Err(e)) = sent {
                if !failed {
                    failed = true;
                    log::warn!("[native_voice] share audio: the source refused a frame: {e}");
                }
            }
        };
        let thread = thread::Builder::new()
            .name("share-audio".into())
            .spawn(move || run(connect_server, deliver, s, i, a))
            .map_err(|e| log::warn!("[native_voice] share audio thread: {e}"))
            .ok();
        Self {
            stop,
            inputs,
            app,
            thread,
        }
    }

    /// Follow a source change: record only application `app` from the next
    /// listing on (within a second), or every application when `None`.
    pub fn set_app(&self, app: Option<u32>) {
        self.app.store(app.unwrap_or(0), Ordering::Release);
    }

    /// How many applications' streams are being recorded right now.
    pub fn inputs(&self) -> usize {
        self.inputs.load(Ordering::Acquire)
    }
}

impl Drop for ShareAudio {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests;
