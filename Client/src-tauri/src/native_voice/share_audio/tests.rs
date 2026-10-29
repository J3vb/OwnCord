//! The capture against a fake sound server: one end of a `UnixStream::pair`
//! and a thread that answers the protocol. No sound server is needed.
use std::sync::Mutex;

use pulseaudio::protocol::{ChannelMap as Map, Props as P, ServerInfo, SinkInfo, SinkInputInfo};

use super::*;

fn me() -> u32 {
    std::process::id()
}

fn props(pairs: &[(&CStr, &str)]) -> P {
    let mut p = P::new();
    for (k, v) in pairs {
        p.set_bytes(*k, CString::new(*v).unwrap().as_bytes_with_nul());
    }
    p
}

fn client(index: u32, name: &str, pairs: &[(&CStr, &str)]) -> ClientInfo {
    ClientInfo {
        index,
        name: CString::new(name).unwrap(),
        props: props(pairs),
        ..Default::default()
    }
}

fn input(index: u32, sink: u32, client: u32, pairs: &[(&CStr, &str)]) -> SinkInputInfo {
    SinkInputInfo {
        index,
        sink_index: sink,
        client_index: Some(client),
        props: props(pairs),
        sample_spec: SampleSpec {
            format: SampleFormat::S16Le,
            channels: 2,
            sample_rate: RATE,
        },
        channel_map: Map::stereo(),
        cvolume: ChannelVolume::norm(2),
        ..Default::default()
    }
}

// ---- pure helpers --------------------------------------------------------

#[test]
fn is_own_matches_the_cpal_client_name() {
    let own = Own::new(1234, BTreeSet::new());
    let clients = [client(1, "cpal-pulseaudio-1234", &[])];
    assert!(is_own(&input(5, 0, 1, &[]), &clients, &own));
    // Another process whose pid merely starts with ours is not ours.
    let clients = [client(1, "cpal-pulseaudio-12345", &[])];
    assert!(!is_own(&input(5, 0, 1, &[]), &clients, &own));
}

#[test]
fn is_own_reads_the_real_pid_of_a_pulse_client_not_the_daemons() {
    let own = Own::new(1234, BTreeSet::from([4321]));
    let daemon = [(PIPEWIRE_SEC_PID, "900")];
    let clients = [client(1, "WebKitWebProcess", &daemon)];
    // (a) pulse client: the sink input carries our child's pid, the client
    // carries the daemon's pipewire.sec.pid.
    assert!(is_own(
        &input(5, 0, 1, &[(c"application.process.id", "4321")]),
        &clients,
        &own
    ));
    // The same shape with a foreign pid is not ours.
    assert!(!is_own(
        &input(5, 0, 1, &[(c"application.process.id", "777")]),
        &clients,
        &own
    ));
}

#[test]
fn is_own_falls_back_to_the_clients_pipewire_pid_for_native_streams() {
    let own = Own::new(1234, BTreeSet::new());
    // (b) native PipeWire client: neither pid on the sink input.
    let ours = [client(1, "pw-client", &[(PIPEWIRE_SEC_PID, "1234")])];
    assert!(is_own(&input(5, 0, 1, &[]), &ours, &own));
    let foreign = [client(1, "pw-client", &[(PIPEWIRE_SEC_PID, "55")])];
    assert!(!is_own(&input(5, 0, 1, &[]), &foreign, &own));
}

#[test]
fn descendants_walks_the_parent_chain() {
    let parents = BTreeMap::from([(30, 20), (20, 10), (10, 1234), (99, 1)]);
    let tree = descendants(1234, [30, 99, 1234], |p| parents.get(&p).copied());
    assert_eq!(tree, BTreeSet::from([1234, 30]));
    // A child of ours is own through its pid.
    let own = Own::new(1234, tree);
    let clients = [client(1, "web", &[])];
    assert!(is_own(
        &input(5, 0, 1, &[(c"application.process.id", "30")]),
        &clients,
        &own
    ));
    // The real /proc walk finds this very process.
    assert_eq!(proc_parent(me()), Some(std::os::unix::process::parent_id()));
}

#[test]
fn wanted_keeps_only_unmuted_foreign_inputs_on_the_default_sink() {
    let own = Own::new(me(), BTreeSet::new());
    let clients = [
        client(1, "app", &[]),
        client(2, &format!("cpal-pulseaudio-{}", me()), &[]),
    ];
    let mut muted = input(12, 1, 1, &[]);
    muted.muted = true;
    let inputs = [
        input(10, 1, 1, &[]),
        input(11, 1, 2, &[]),
        muted,
        input(13, 2, 1, &[]),
    ];
    assert_eq!(
        wanted(&inputs, Some(1), &clients, &own, None),
        BTreeSet::from([10])
    );
    assert!(wanted(&inputs, None, &clients, &own, None).is_empty());
}

#[test]
fn wanted_keeps_only_the_shared_apps_tree_when_one_is_given() {
    let own = Own::new(me(), BTreeSet::new());
    let pid = |p: &'static str| [(c"application.process.id", p)];
    let clients = [
        client(1, "firefox", &pid("500")),
        client(2, "mpv", &pid("600")),
    ];
    let inputs = [
        input(10, 1, 1, &[]),
        // The browser's audio child plays under its own pid.
        input(11, 1, 2, &pid("501")),
        input(12, 1, 2, &[]),
    ];
    let firefox = BTreeSet::from([500, 501]);
    assert_eq!(
        wanted(&inputs, Some(1), &clients, &own, Some(&firefox)),
        BTreeSet::from([10, 11])
    );
    // An app that plays nothing records nothing, not everyone else.
    assert!(wanted(
        &inputs,
        Some(1),
        &clients,
        &own,
        Some(&BTreeSet::from([700]))
    )
    .is_empty());
    assert_eq!(
        wanted(&inputs, Some(1), &clients, &own, None),
        BTreeSet::from([10, 11, 12])
    );
}

#[test]
fn the_socket_is_found_by_pulse_server_then_the_runtime_dir() {
    let all = |_: &Path| true;
    let path = |ps, rt, xdg| socket_path_in(ps, rt, xdg, all);
    assert_eq!(
        path(Some("unix:/run/p/native"), Some("/rt"), Some("/run/user/1")),
        Some(PathBuf::from("/run/p/native"))
    );
    assert_eq!(
        path(None, Some("/rt"), Some("/run/user/1")),
        Some(PathBuf::from("/rt/native"))
    );
    assert_eq!(
        path(None, None, Some("/run/user/1")),
        Some(PathBuf::from("/run/user/1/pulse/native"))
    );
    // A bare path and a machine-qualified entry are local too.
    assert_eq!(
        path(Some("/run/q/native"), Some("/rt"), None),
        Some(PathBuf::from("/run/q/native"))
    );
    assert_eq!(
        path(Some("{abc123}unix:/run/m/native tcp:host"), None, None),
        Some(PathBuf::from("/run/m/native"))
    );
    assert_eq!(
        path(Some("{abc123}/run/b/native"), None, None),
        Some(PathBuf::from("/run/b/native"))
    );
    // Only remote servers named: the local socket is not the one in use.
    assert_eq!(
        path(Some("tcp:host"), Some("/rt"), Some("/run/user/1")),
        None
    );
    assert_eq!(socket_path_in(None, None, Some("/x"), |_| false), None);
    assert_eq!(path(None, None, None), None);
}

// ---- the fake server ----------------------------------------------------

#[derive(Clone, Copy)]
struct Tone {
    hz: f32,
}

struct Scene {
    default_sink: &'static str,
    /// (sink index, input index, client index, tone)
    inputs: Vec<(u32, u32, u32, Tone)>,
    clients: Vec<ClientInfo>,
}

#[derive(Debug, PartialEq)]
enum Seen {
    Create(u32),
    Delete(u32),
}

type Shared<T> = Arc<Mutex<T>>;

struct Fake {
    scene: Shared<Scene>,
    seen: Shared<Vec<Seen>>,
    /// One stop flag per connection the fake accepted.
    conns: Shared<Vec<Arc<AtomicBool>>>,
    /// Set when a fake connection saw the client's EOF.
    eof: Arc<AtomicBool>,
    /// A channel the fake announces as killed on its next turn.
    kill: Shared<Option<u32>>,
}

fn at<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn serve(
    sock: UnixStream,
    scene: Shared<Scene>,
    seen: Shared<Vec<Seen>>,
    stop: Arc<AtomicBool>,
    eof: Arc<AtomicBool>,
    kill: Shared<Option<u32>>,
) {
    let mut conn = Conn::new(sock).unwrap();
    let mut open: BTreeMap<u32, (Tone, u64)> = BTreeMap::new();
    let mut next_channel = 0;
    let mut next_audio = Instant::now();
    while !stop.load(Ordering::Acquire) {
        let killed = at(&kill).take();
        if let Some(channel) = killed {
            open.remove(&channel);
            let v = protocol::MAX_VERSION;
            protocol::write_command_message(
                &mut conn.sock,
                0,
                &Command::RecordStreamKilled(channel),
                v,
            )
            .unwrap();
        }
        match conn.frame(next_audio) {
            Err(_) => {
                eof.store(true, Ordering::Release);
                return;
            }
            Ok(Some(frame)) => {
                let Some((seq, cmd)) = frame.control(protocol::MAX_VERSION) else {
                    continue;
                };
                let w = &mut conn.sock;
                let v = protocol::MAX_VERSION;
                let s = at(&scene);
                match cmd {
                    Command::Auth(_) => protocol::write_reply_message(
                        w,
                        seq,
                        &AuthReply {
                            version: v,
                            ..Default::default()
                        },
                        v,
                    ),
                    Command::SetClientName(_) => protocol::write_reply_message(
                        w,
                        seq,
                        &SetClientNameReply { client_id: 1 },
                        v,
                    ),
                    Command::GetServerInfo => protocol::write_reply_message(
                        w,
                        seq,
                        &ServerInfo {
                            default_sink_name: Some(CString::new(s.default_sink).unwrap()),
                            ..Default::default()
                        },
                        v,
                    ),
                    Command::GetSinkInfoList => {
                        let sinks: SinkInfoList = [(1, "main"), (2, "other")]
                            .iter()
                            .map(|&(i, n)| SinkInfo {
                                name: CString::new(n).unwrap(),
                                ..SinkInfo::new_dummy(i)
                            })
                            .collect();
                        protocol::write_reply_message(w, seq, &sinks, v)
                    }
                    Command::GetSinkInputInfoList => {
                        let list: SinkInputInfoList = s
                            .inputs
                            .iter()
                            .map(|&(sink, idx, cl, _)| input(idx, sink, cl, &[]))
                            .collect();
                        protocol::write_reply_message(w, seq, &list, v)
                    }
                    Command::GetClientInfoList => {
                        protocol::write_reply_message(w, seq, &s.clients.clone(), v)
                    }
                    Command::CreateRecordStream(p) => {
                        let idx = p.direct_on_input_index.unwrap();
                        assert_eq!(p.sample_spec.format, SampleFormat::S16Le);
                        assert_eq!(
                            (p.sample_spec.channels, p.sample_spec.sample_rate),
                            (2, RATE)
                        );
                        assert!(p.flags.adjust_latency);
                        assert_eq!(p.buffer_attr.fragment_size, 1920);
                        let tone = s.inputs.iter().find(|i| i.1 == idx).unwrap().3;
                        next_channel += 1;
                        open.insert(next_channel, (tone, 0));
                        at(&seen).push(Seen::Create(idx));
                        protocol::write_reply_message(
                            w,
                            seq,
                            &CreateRecordStreamReply {
                                channel: next_channel,
                                stream_index: next_channel,
                                sample_spec: p.sample_spec,
                                channel_map: p.channel_map,
                                ..Default::default()
                            },
                            v,
                        )
                    }
                    Command::DeleteRecordStream(ch) => {
                        open.remove(&ch);
                        at(&seen).push(Seen::Delete(ch));
                        protocol::write_ack_message(w, seq)
                    }
                    _ => Ok(()),
                }
                .unwrap();
            }
            Ok(None) => {}
        }
        if Instant::now() >= next_audio {
            next_audio += TICK;
            for (&channel, (tone, n)) in open.iter_mut() {
                let mut bytes = Vec::with_capacity(FRAME * 4);
                for _ in 0..FRAME {
                    let t = *n as f32 / RATE as f32;
                    let s = ((t * tone.hz * std::f32::consts::TAU).sin() * 8000.0) as i16;
                    bytes.extend_from_slice(&s.to_le_bytes());
                    bytes.extend_from_slice(&s.to_le_bytes());
                    *n += 1;
                }
                if protocol::write_memblock(&mut conn.sock, channel, &bytes, 0).is_err() {
                    eof.store(true, Ordering::Release);
                    return;
                }
            }
        }
    }
}

impl Fake {
    fn new(default_sink: &'static str, inputs: Vec<(u32, u32, u32, Tone)>) -> Self {
        let clients = vec![
            client(1, "firefox", &[]),
            client(2, &format!("cpal-pulseaudio-{}", me()), &[]),
            client(3, "mpv", &[]),
        ];
        Self {
            scene: Arc::new(Mutex::new(Scene {
                default_sink,
                inputs,
                clients,
            })),
            seen: Arc::default(),
            conns: Arc::default(),
            eof: Arc::default(),
            kill: Arc::default(),
        }
    }

    /// A `connect` for `run`: each call starts a fresh fake connection.
    fn connector(&self) -> impl FnMut() -> io::Result<UnixStream> {
        let (scene, seen, conns, eof, kill) = (
            Arc::clone(&self.scene),
            Arc::clone(&self.seen),
            Arc::clone(&self.conns),
            Arc::clone(&self.eof),
            Arc::clone(&self.kill),
        );
        move || {
            let (ours, theirs) = UnixStream::pair()?;
            let stop = Arc::new(AtomicBool::new(false));
            at(&conns).push(Arc::clone(&stop));
            let (scene, seen, eof, kill) = (
                Arc::clone(&scene),
                Arc::clone(&seen),
                Arc::clone(&eof),
                Arc::clone(&kill),
            );
            thread::spawn(move || serve(theirs, scene, seen, stop, eof, kill));
            Ok(ours)
        }
    }
}

struct Running {
    stop: Arc<AtomicBool>,
    frames: Shared<Vec<Vec<i16>>>,
    inputs: Arc<AtomicUsize>,
    app: Arc<AtomicU32>,
    thread: Option<JoinHandle<()>>,
}

impl Running {
    fn start(fake: &Fake, reconnect: Duration) -> Self {
        Self::start_with(fake, reconnect, 0)
    }

    /// As `start`, recording only application `pid` (0: every one).
    fn start_with(fake: &Fake, reconnect: Duration, pid: u32) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let frames: Shared<Vec<Vec<i16>>> = Arc::default();
        let inputs: Arc<AtomicUsize> = Arc::default();
        let app = Arc::new(AtomicU32::new(pid));
        let (f, s, i, a) = (
            Arc::clone(&frames),
            Arc::clone(&stop),
            Arc::clone(&inputs),
            Arc::clone(&app),
        );
        let connect = fake.connector();
        let timing = Timing {
            poll: Duration::from_millis(40),
            reconnect,
        };
        let thread = thread::spawn(move || {
            run_with(
                timing,
                connect,
                move |pcm| at(&f).push(pcm.to_vec()),
                s,
                i,
                a,
            )
        });
        Self {
            stop,
            frames,
            inputs,
            app,
            thread: Some(thread),
        }
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop();
    }
}

fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !ok() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(5));
    }
}

/// Goertzel magnitude of `hz` in the left channel of interleaved stereo.
fn power(pcm: &[i16], hz: f32) -> f32 {
    let w = std::f32::consts::TAU * hz / RATE as f32;
    let (mut re, mut im) = (0.0f32, 0.0f32);
    for (n, s) in pcm
        .as_chunks::<2>()
        .0
        .iter()
        .map(|f| f[0] as f32)
        .enumerate()
    {
        re += s * (w * n as f32).cos();
        im += s * (w * n as f32).sin();
    }
    (re * re + im * im).sqrt() / (pcm.len() / 2) as f32
}

fn ready_inputs(fake: &Fake) -> Vec<Seen> {
    std::mem::take(&mut *at(&fake.seen))
}

// ---- behaviour -----------------------------------------------------------

#[test]
fn own_and_off_default_streams_are_never_recorded() {
    let tone = Tone { hz: 440.0 };
    // Our cpal client (2), another app (1) and a third on the other sink.
    let fake = Fake::new(
        "main",
        vec![(1, 10, 2, tone), (1, 11, 1, tone), (2, 12, 3, tone)],
    );
    let run = Running::start(&fake, Duration::from_millis(100));
    wait_for("the first create", || !at(&fake.seen).is_empty());
    // Several more polls pass without another create.
    thread::sleep(Duration::from_millis(250));
    drop(run);
    assert_eq!(*at(&fake.seen), vec![Seen::Create(11)]);
}

#[test]
fn a_shared_app_records_only_its_streams_and_follows_a_change() {
    let tone = Tone { hz: 440.0 };
    let fake = Fake::new("main", vec![(1, 11, 1, tone), (1, 13, 3, tone)]);
    {
        let mut scene = at(&fake.scene);
        let pid = |p: &'static str| [(c"application.process.id", p)];
        scene.clients[0] = client(1, "firefox", &pid("4000001"));
        scene.clients[2] = client(3, "mpv", &pid("4000002"));
    }
    let run = Running::start_with(&fake, Duration::from_millis(100), 4_000_001);
    wait_for("the first create", || !at(&fake.seen).is_empty());
    thread::sleep(Duration::from_millis(150));
    assert_eq!(*at(&fake.seen), vec![Seen::Create(11)]);
    // A source change to the player's window.
    run.app.store(4_000_002, Ordering::Release);
    wait_for("the swap", || at(&fake.seen).len() >= 3);
    assert_eq!(
        *at(&fake.seen),
        vec![Seen::Create(11), Seen::Delete(1), Seen::Create(13)]
    );
}

#[test]
fn a_default_sink_move_swaps_the_recorded_streams() {
    let tone = Tone { hz: 440.0 };
    let fake = Fake::new("main", vec![(1, 11, 1, tone), (2, 12, 3, tone)]);
    let _run = Running::start(&fake, Duration::from_millis(100));
    wait_for("the first create", || !at(&fake.seen).is_empty());
    at(&fake.scene).default_sink = "other";
    wait_for("the swap", || at(&fake.seen).len() >= 3);
    assert_eq!(
        *at(&fake.seen),
        vec![Seen::Create(11), Seen::Delete(1), Seen::Create(12)]
    );
}

#[test]
fn recorded_audio_is_mixed_into_ten_ms_stereo_frames() {
    let fake = Fake::new(
        "main",
        vec![
            (1, 11, 1, Tone { hz: 440.0 }),
            (1, 12, 3, Tone { hz: 660.0 }),
        ],
    );
    let run = Running::start(&fake, Duration::from_millis(100));
    wait_for("both streams to play", || {
        at(&fake.seen).len() == 2 && at(&run.frames).len() > 80
    });
    thread::sleep(Duration::from_millis(300));
    let frames = at(&run.frames).clone();
    assert!(frames.iter().all(|f| f.len() == FRAME * 2));
    let tail: Vec<i16> = frames[frames.len() - 20..].concat();
    let (a, b, other) = (
        power(&tail, 440.0),
        power(&tail, 660.0),
        power(&tail, 1000.0),
    );
    assert!(a > 500.0 && b > 500.0, "tones 440={a} 660={b}");
    assert!(other < a / 10.0 && other < b / 10.0, "off-tone {other}");
}

#[test]
fn dropping_stops_the_thread_and_closes_the_socket() {
    let fake = Fake::new("main", vec![(1, 11, 1, Tone { hz: 440.0 })]);
    let mut run = Running::start(&fake, Duration::from_millis(100));
    wait_for("the stream", || !at(&fake.seen).is_empty());
    let started = Instant::now();
    run.stop();
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "{:?}",
        started.elapsed()
    );
    wait_for("EOF at the fake", || fake.eof.load(Ordering::Acquire));
    assert!(started.elapsed() < Duration::from_millis(200));
}

#[test]
fn a_hung_server_does_not_delay_a_stop() {
    // Accepts the connection and never answers the handshake.
    let (ours, _silent) = UnixStream::pair().unwrap();
    let mut once = Some(ours);
    let stop = Arc::new(AtomicBool::new(false));
    let s = Arc::clone(&stop);
    let thread = thread::spawn(move || {
        run_with(
            Timing {
                poll: Duration::from_millis(40),
                reconnect: Duration::from_millis(100),
            },
            move || once.take().ok_or_else(|| io::ErrorKind::NotFound.into()),
            |_| {},
            s,
            Arc::default(),
            Arc::default(),
        )
    });
    thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    stop.store(true, Ordering::Release);
    thread.join().unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a_killed_record_stream_is_recreated_by_the_next_poll() {
    let fake = Fake::new("main", vec![(1, 11, 1, Tone { hz: 440.0 })]);
    let run = Running::start(&fake, Duration::from_millis(100));
    wait_for("the first create", || !at(&fake.seen).is_empty());
    *at(&fake.kill) = Some(1);
    wait_for("the recreate", || at(&fake.seen).len() == 2);
    assert_eq!(*at(&fake.seen), vec![Seen::Create(11), Seen::Create(11)]);
    wait_for("the stream back", || {
        run.inputs.load(Ordering::Acquire) == 1
    });
}

#[test]
fn an_input_that_vanishes_is_dropped_and_goes_silent() {
    let fake = Fake::new("main", vec![(1, 11, 1, Tone { hz: 440.0 })]);
    let run = Running::start(&fake, Duration::from_millis(100));
    wait_for("the stream", || run.inputs.load(Ordering::Acquire) == 1);
    at(&fake.scene).inputs.clear();
    wait_for("the stream to go", || {
        run.inputs.load(Ordering::Acquire) == 0
    });
    assert_eq!(*at(&fake.seen), vec![Seen::Create(11), Seen::Delete(1)]);
    thread::sleep(Duration::from_millis(100));
    let frames = at(&run.frames).clone();
    assert!(frames[frames.len() - 5..]
        .iter()
        .all(|f| f.iter().all(|&s| s == 0)));
}

#[test]
fn a_server_restart_keeps_the_track_fed_and_resumes() {
    let fake = Fake::new("main", vec![(1, 11, 1, Tone { hz: 440.0 })]);
    let run = Running::start(&fake, Duration::from_millis(300));
    wait_for("audio", || {
        at(&run.frames)
            .iter()
            .rev()
            .take(10)
            .any(|f| f.iter().any(|&s| s != 0))
    });
    // The server goes away.
    at(&fake.conns)[0].store(true, Ordering::Release);
    let killed_at = at(&run.frames).len();
    thread::sleep(Duration::from_millis(100));
    let mid_gap = at(&run.frames).len();
    assert!(
        mid_gap >= killed_at + 5,
        "frames stopped: {killed_at} -> {mid_gap}"
    );
    // The second connection records again and the sound returns.
    wait_for("the second create", || at(&fake.seen).len() == 2);
    wait_for("audio again", || {
        at(&run.frames)
            .iter()
            .rev()
            .take(10)
            .any(|f| f.iter().any(|&s| s != 0))
    });
    let frames = at(&run.frames).clone();
    // A frame or two of audio may already be on its way out when the socket
    // dies; past that the gap is silence until the new stream plays.
    let after = &frames[killed_at + 3..];
    let quiet = after
        .iter()
        .take_while(|f| f.iter().all(|&s| s == 0))
        .count();
    assert!(quiet >= 5, "gap of {quiet} silent frames");
    assert_eq!(*at(&fake.seen), vec![Seen::Create(11), Seen::Create(11)]);
    assert_eq!(ready_inputs(&fake).len(), 2);
}

/// Against the user's real sound server: `cargo test -- --ignored share_audio_real`.
/// Needs `pacat` and a cpal output. Three tones play at once: 440 Hz from a
/// detached player (an unrelated process, captured), 660 Hz through our own
/// cpal output (excluded by the client name) and 880 Hz from a direct child
/// of the test (excluded by the process tree, like the WebKit web process).
/// Only 440 Hz may come out. This is also the check that a cpal bump has not
/// renamed its client.
#[test]
#[ignore = "needs a running PulseAudio or pipewire-pulse server, pacat and an output"]
#[allow(clippy::disallowed_methods)] // scratch files for the players, not stores
fn share_audio_real() {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::process::Command as Proc;
    assert!(available(), "no sound server answers");
    fn tone_file(hz: f32, tag: &str) -> PathBuf {
        let mut tone = Vec::new();
        for n in 0..RATE as usize * 12 {
            let s = ((n as f32 / RATE as f32 * hz * std::f32::consts::TAU).sin() * 8000.0) as i16;
            tone.extend_from_slice(&s.to_le_bytes());
            tone.extend_from_slice(&s.to_le_bytes());
        }
        let file = std::env::temp_dir().join(format!("share-audio-{tag}-{}.raw", me()));
        std::fs::write(&file, &tone).unwrap();
        file
    }
    const PACAT: [&str; 5] = [
        "--playback",
        "--raw",
        "--format=s16le",
        "--rate=48000",
        "--channels=2",
    ];
    let (foreign, child_tone) = (tone_file(440.0, "foreign"), tone_file(880.0, "child"));
    // Detached through a shell, so it is not our child.
    let out = Proc::new("sh")
        .args([
            "-c",
            "pacat --playback --raw --format=s16le --rate=48000 --channels=2 <\"$1\" >/dev/null 2>&1 & echo $!",
            "sh",
        ])
        .arg(&foreign)
        .output()
        .unwrap();
    let player = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let mut child = Proc::new("pacat")
        .args(PACAT)
        .stdin(std::fs::File::open(&child_tone).unwrap())
        .spawn()
        .unwrap();
    // Our own playback, through a cpal host as OwnCord's playout does.
    let device = cpal::default_host().default_output_device().unwrap();
    let config = device.default_output_config().unwrap();
    let (channels, rate) = (config.channels() as usize, config.sample_rate() as f32);
    let mut n = 0u64;
    let own = device
        .build_output_stream::<f32, _, _>(
            config.config(),
            move |out: &mut [f32], _| {
                for frame in out.chunks_mut(channels) {
                    let s = (n as f32 / rate * 660.0 * std::f32::consts::TAU).sin() * 0.25;
                    frame.iter_mut().for_each(|o| *o = s);
                    n += 1;
                }
            },
            |e| eprintln!("cpal output: {e}"),
            None,
        )
        .unwrap();
    own.play().unwrap();

    let stop = Arc::new(AtomicBool::new(false));
    let frames: Shared<Vec<Vec<i16>>> = Arc::default();
    let f = Arc::clone(&frames);
    let s = Arc::clone(&stop);
    let thread = thread::spawn(move || {
        run(
            connect_server,
            move |pcm| at(&f).push(pcm.to_vec()),
            s,
            Arc::default(),
            Arc::default(),
        )
    });
    wait_for("captured tone", || {
        let frames = at(&frames);
        frames.len() > 30 && power(&frames[frames.len() - 10..].concat(), 440.0) > 500.0
    });
    // Let the other two get through a few polls and the mixer's priming.
    thread::sleep(Duration::from_secs(2));
    let tail = {
        let frames = at(&frames);
        frames[frames.len() - 50..].concat()
    };
    let (foreign_hz, own_hz, child_hz) = (
        power(&tail, 440.0),
        power(&tail, 660.0),
        power(&tail, 880.0),
    );
    stop.store(true, Ordering::Release);
    thread.join().unwrap();
    drop(own);
    let _ = child.kill();
    let _ = child.wait();
    let _ = Proc::new("kill").arg(player).status();
    let _ = std::fs::remove_file(foreign);
    let _ = std::fs::remove_file(child_tone);
    assert!(
        foreign_hz > 500.0,
        "the foreign tone is missing: {foreign_hz}"
    );
    assert!(own_hz < 50.0, "our own cpal playout leaked: {own_hz}");
    assert!(
        child_hz < 50.0,
        "a child process's audio leaked: {child_hz}"
    );
}
