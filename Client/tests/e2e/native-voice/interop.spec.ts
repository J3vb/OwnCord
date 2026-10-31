// Native <-> livekit-client E2EE interop (Linux). The Rust peer is the app's
// own NativeSession (examples/native_voice_interop.rs); the browser peer is
// livekit-client with ExternalE2EEKeyProvider, e2ee worker and
// setE2EEEnabled(true) — exactly what the Windows client does in
// features/voice/roomLifecycle.ts. Both are handed the same base64 room-key
// text. What this proves, end to end over a real livekit-server:
//   1. audio decodes in both directions with the same key (a 440 Hz sine of
//      amplitude 8000 from the native side is measured at its exact RMS in
//      the browser);
//   2. the negative control: a native peer holding a different key produces
//      silence and decryption errors in the browser, and hears silence —
//      the media really is encrypted, not passed through;
//   3. repeated native joins do not leak threads (rust-sdks #1408 measure);
//   4. repeated mute/unmute keeps the publication, so it adds no threads;
//   5. video decodes in both directions with the same key: the native camera
//      (uploaded over the app's loopback frame socket) plays in the browser,
//      and the browser's camera is read back through that socket; the socket
//      refuses a wrong token and is gone after close;
//   6. the video negative control: with a wrong key neither side decodes a
//      single video frame;
//   7. per-user volume: the native session's own playout mix plays the
//      browser peer at the volume set for it (the runner has no sound
//      device, so the peer pulls the mix itself);
//   8. a native screen share (a synthetic capture source, through the app's
//      capture thread and publish) decodes in the browser with the same key,
//      its local preview arrives on the frame socket, and repeated share
//      stop/start releases every capturer;
//   9. the screen-share negative control: with a wrong key the browser
//      decodes not one frame of it;
//  10. a native H.264 camera (the Linux codec choice, WP LP-7c) decodes in the
//      browser (Google Chrome) with the same key; skipped locally, with the
//      reason, where the native engine cannot encode H.264 or the browser
//      cannot decode it, and a failure under CI.
//  11. a browser VP9 camera (WP M-11a) decodes natively with the same key,
//      after checking the browser really sent VP9; skipped locally, with the
//      reason, where either side lacks VP9, and a failure under CI;
//  12. its negative control: with a wrong key not one VP9 frame decodes;
//  13. a native VP9 camera (WP M-11b, one L1T3 layer, no simulcast) decodes in
//      the browser with the same key, after checking the browser received VP9;
//      skipped locally, with the reason, where the native engine cannot
//      encode VP9, and a failure under CI;
//  14. the same for a native VP9 screen share;
//  15. the negative control: with a wrong key not one frame of the VP9 camera
//      or share decodes.
// Not exercised here: the X11 capturer and the Wayland portal (CI has no
// display); see docs/architecture/voice-e2ee.md.
// Requires OWNCORD_E2E_LIVEKIT_BINARY and OWNCORD_NATIVE_VOICE_PEER.
import { test, expect } from "@playwright/test";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { freePorts, freeUdpPort, startProcess, stopProcess, waitForHttp } from "../support/process";

/** livekit-client's package exports hide dist/; the spec runs from Client/. */
const livekitDist = resolve("node_modules/livekit-client/dist");

const KEY_ID = "e2e-key";
const API_SECRET = "e2e-secret-at-least-32-characters-long";
/** One room per test: tests reuse the same identities against one server, and
 *  a previous test's peers can still be in the room when the next one joins. */
let room = "native-interop";
/** 440 Hz sine, amplitude 8000 of 32768: RMS = 8000/32768/sqrt(2). */
const EXPECTED_SINE_RMS = 8000 / 32768 / Math.SQRT2;
/** The per-user volume the native peer plays the browser peer at. */
const PEER_VOLUME = 0.5;

const livekitBinary = process.env.OWNCORD_E2E_LIVEKIT_BINARY;
const nativePeer = process.env.OWNCORD_NATIVE_VOICE_PEER;
test.skip(
  process.platform !== "linux" || !livekitBinary || !nativePeer,
  "Linux with OWNCORD_E2E_LIVEKIT_BINARY and OWNCORD_NATIVE_VOICE_PEER only",
);

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** A LiveKit join token, HS256, the way livekit-server-sdk mints one. */
function joinToken(identity: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: KEY_ID,
      sub: identity,
      nbf: now - 10,
      exp: now + 600,
      video: { room, roomJoin: true, canPublish: true, canSubscribe: true },
    }),
  );
  const signature = b64url(
    createHmac("sha256", API_SECRET).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}

type NativeLine = { event: Record<string, unknown> & { type: string } };

/** The command line every native peer in these tests starts from. */
function nativePeerArgs(url: string, key: string, secs: number, ...extra: string[]): string[] {
  return [
    "--url",
    url,
    "--token",
    joinToken("user-2"),
    "--key",
    key,
    "--secs",
    String(secs),
    ...extra,
  ];
}

/** Run the native peer to completion and return its JSON lines. */
function runNativePeer(
  args: string[],
  onLine?: (line: NativeLine) => void,
): { child: ChildProcess; done: Promise<NativeLine[]> } {
  const { child, log } = startProcess(resolve(nativePeer!), args, process.cwd(), {
    ...process.env,
    RUST_LOG: "warn",
  });
  const lines: NativeLine[] = [];
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.startsWith("{")) continue;
      const line = JSON.parse(part) as NativeLine;
      lines.push(line);
      onLine?.(line);
    }
  });
  const done = new Promise<NativeLine[]>((resolveDone, reject) => {
    child.on("exit", (code: number | null) =>
      code === 0
        ? resolveDone(lines)
        : reject(new Error(`native peer exited ${code}: ${log().slice(-2000)}`)),
    );
  });
  return { child, done };
}

let livekit: ReturnType<typeof startProcess>;
let livekitPort: number;
let dataDir: string;

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "owncord-native-voice-"));
  const ports = await freePorts("livekit", "rtc");
  livekitPort = ports.livekit;
  const rtcPort = ports.rtc;
  const rtcUdpPort = await freeUdpPort();
  const config = join(dataDir, "livekit.yaml");
  await writeFile(
    config,
    `port: ${livekitPort}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${rtcPort}\n  udp_port: ${rtcUdpPort}\n  use_external_ip: false\n  node_ip: 127.0.0.1\n  enable_loopback_candidate: true\n  ips:\n    includes: [127.0.0.1/32]\nlogging:\n  level: warn\nkeys:\n  ${KEY_ID}: ${API_SECRET}\n`,
  );
  livekit = startProcess(resolve(livekitBinary!), ["--config", config], dataDir);
  await waitForHttp(`http://127.0.0.1:${livekitPort}`, livekit);
});

test.beforeEach(() => {
  const testInfo = test.info();
  room = `native-interop-${testInfo.testId}-${testInfo.retry}`;
});

test.afterAll(async () => {
  if (livekit) await stopProcess(livekit.child);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

/** The browser peer: livekit-client as the app uses it, plus a decoded-audio
 *  meter on every remote audio track and an EncryptionError counter. */
async function joinBrowserPeer(
  page: import("@playwright/test").Page,
  url: string,
  token: string,
  keyBase64: string,
  video = false,
  videoCodec?: "vp9",
) {
  // livekit-server answers "OK" at /, which is enough of an origin for a
  // worker and WebRTC; the SDK and its worker come from node_modules.
  await page.route("**/e2ee-worker.js", (route) =>
    route.fulfill({ path: join(livekitDist, "livekit-client.e2ee.worker.js") }),
  );
  await page.goto(`http://127.0.0.1:${livekitPort}/`);
  await page.addScriptTag({ path: join(livekitDist, "livekit-client.umd.js") });
  await page.evaluate(
    async ({ url, token, keyBase64, video, videoCodec }) => {
      const lk = (window as unknown as { LivekitClient: typeof import("livekit-client") })
        .LivekitClient;
      const meters = new Map<string, { sumSq: number; samples: number }>();
      const videos = new Map<string, { frames: number; width: number; height: number }>();
      // The screen-share audio's own readings, keyed `<identity>#screenaudio`:
      // its sid, how often it was subscribed, the channel count the browser
      // reports for it, and the left and right levels.
      const shareAudio = new Map<
        string,
        { sid: string; subscriptions: number; channels: number; left: number; right: number }
      >();
      const state = {
        encErrors: 0,
        reconnects: 0,
        subscribed: [] as string[],
        meters,
        videos,
        shareAudio,
      };
      (window as unknown as { __interop: typeof state }).__interop = state;
      const keyProvider = new lk.ExternalE2EEKeyProvider();
      await keyProvider.setKey(keyBase64);
      const room = new lk.Room({
        e2ee: { keyProvider, worker: new Worker("/e2ee-worker.js") },
      });
      await room.setE2EEEnabled(true);
      room.on(lk.RoomEvent.EncryptionError, () => {
        state.encErrors++;
      });
      // The SFU can answer a failed negotiation with a full reconnect, which
      // drops every subscription until the peer republishes.
      room.on(lk.RoomEvent.Reconnecting, () => {
        state.reconnects++;
      });
      const ctx = new AudioContext({ sampleRate: 48000 });
      room.on(lk.RoomEvent.TrackSubscribed, (track, pub, participant) => {
        if (track.kind === lk.Track.Kind.Video) {
          // Count decoded frames the way a tile renders them.
          const el = track.attach() as HTMLVideoElement;
          el.muted = true;
          document.body.appendChild(el);
          const v = { frames: 0, width: 0, height: 0 };
          // A screen share is read as `<identity>#screen`.
          const key =
            pub.source === lk.Track.Source.ScreenShare
              ? `${participant.identity}#screen`
              : participant.identity;
          videos.set(key, v);
          // Tells a peer cycling its camera that this subscription is fully
          // negotiated, so it may unpublish the camera (see the native
          // example's `--camera-cycles`).
          if (pub.source === lk.Track.Source.Camera)
            void room.localParticipant.publishData(new TextEncoder().encode(pub.trackSid), {
              reliable: true,
              topic: "camera-subscribed",
            });
          const onFrame = (_now: number, meta: { width: number; height: number }) => {
            v.frames++;
            v.width = meta.width;
            v.height = meta.height;
            el.requestVideoFrameCallback(onFrame);
          };
          el.requestVideoFrameCallback(onFrame);
          return;
        }
        if (track.kind !== lk.Track.Kind.Audio) return;
        const isShareAudio = pub.source === lk.Track.Source.ScreenShareAudio;
        const key = isShareAudio ? `${participant.identity}#screenaudio` : participant.identity;
        state.subscribed.push(key);
        // Chromium only decodes a remote track that is attached somewhere.
        const el = track.attach() as HTMLAudioElement;
        el.volume = 0;
        document.body.appendChild(el);
        const meter = { sumSq: 0, samples: 0 };
        meters.set(key, meter);
        const source = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
        if (isShareAudio) {
          const reading = shareAudio.get(key) ?? {
            sid: pub.trackSid,
            subscriptions: 0,
            channels: 0,
            left: 0,
            right: 0,
          };
          reading.sid = pub.trackSid;
          reading.subscriptions++;
          reading.channels = track.mediaStreamTrack.getSettings().channelCount ?? 0;
          shareAudio.set(key, reading);
          const splitter = ctx.createChannelSplitter(2);
          source.connect(splitter);
          const [left, right] = [ctx.createAnalyser(), ctx.createAnalyser()];
          splitter.connect(left, 0);
          splitter.connect(right, 1);
          const sides = new Float32Array(left.fftSize);
          const peak = (a: AnalyserNode) => {
            a.getFloatTimeDomainData(sides);
            return sides.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
          };
          setInterval(() => {
            reading.left = Math.max(reading.left, peak(left));
            reading.right = Math.max(reading.right, peak(right));
          }, 100);
        }
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          for (const v of buf) meter.sumSq += v * v;
          meter.samples += buf.length;
        }, 100);
      });
      await room.connect(url, token);
      await room.localParticipant.setMicrophoneEnabled(true);
      if (video) await room.localParticipant.setCameraEnabled(true, undefined, { videoCodec });
      (window as unknown as { __room: typeof room }).__room = room;
    },
    { url, token, keyBase64, video, videoCodec },
  );
}

/** The mime type the browser camera actually sends: livekit-client quietly
 *  falls back to VP8 when the codec asked for is not available. */
async function browserCameraCodec(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(async () => {
    const room = (window as unknown as { __room: import("livekit-client").Room }).__room;
    for (let i = 0; i < 40; i++) {
      const pub = [...room.localParticipant.videoTrackPublications.values()][0];
      const report = await pub?.track?.getRTCStatsReport();
      let codecId: string | undefined;
      report?.forEach((s: { type: string; kind?: string; codecId?: string }) => {
        if (s.type === "outbound-rtp" && s.kind === "video" && s.codecId) codecId = s.codecId;
      });
      const codec = codecId === undefined ? undefined : report?.get(codecId);
      if (codec !== undefined) return String((codec as { mimeType: string }).mimeType);
      await new Promise((r) => setTimeout(r, 250));
    }
    return "unknown";
  });
}

/** Fails in CI, skips locally, when the browser did not publish VP9. */
async function expectBrowserVp9(page: import("@playwright/test").Page): Promise<void> {
  const codec = (await browserCameraCodec(page)).toLowerCase();
  if (process.env.CI) expect(codec, "the browser did not publish VP9").toBe("video/vp9");
  else test.skip(codec !== "video/vp9", `the browser published ${codec}, not VP9`);
}

/** The mime type the browser received for `identity`'s video of `source`
 *  (`camera` or `screen_share`), from the receiver's inbound-rtp stats. A
 *  sender that quietly fell back to VP8 would read `video/VP8`. */
async function browserReceivedCodec(
  page: import("@playwright/test").Page,
  identity: string,
  source: "camera" | "screen_share",
): Promise<string> {
  return page.evaluate(
    async ({ identity, source }) => {
      const room = (window as unknown as { __room: import("livekit-client").Room }).__room;
      for (let i = 0; i < 40; i++) {
        const pubs = [
          ...(room.remoteParticipants.get(identity)?.videoTrackPublications.values() ?? []),
        ];
        const track = pubs.find((p) => p.source === source)?.track;
        const report = await track?.receiver?.getStats();
        let codecId: string | undefined;
        report?.forEach((st: { type: string; kind?: string; codecId?: string }) => {
          if (st.type === "inbound-rtp" && st.kind === "video" && st.codecId) codecId = st.codecId;
        });
        const codec = codecId === undefined ? undefined : report?.get(codecId);
        if (codec !== undefined) return String((codec as { mimeType: string }).mimeType);
        await new Promise((r) => setTimeout(r, 250));
      }
      return "unknown";
    },
    { identity, source },
  );
}

/** Whether the native engine can encode VP9 (WP M-11b), by its own probe. In
 *  CI a missing encoder is a failure: VP9 stays off the Linux picker until
 *  these cases have run green there. Locally they skip with the reason. */
async function gateNativeVp9Encode(): Promise<void> {
  const probe = await runNativePeer(["--probe-codecs"]).done;
  const encodes = probe.some((l) => l.event.type === "codecs" && l.event.vp9 === true);
  if (process.env.CI) expect(encodes, "the native engine cannot encode VP9").toBe(true);
  else test.skip(!encodes, "the native engine cannot encode VP9 in this build");
}

/** Fails in CI, skips locally, when the browser did not receive VP9. */
async function expectBrowserReceivedVp9(
  page: import("@playwright/test").Page,
  source: "camera" | "screen_share",
): Promise<void> {
  const codec = (await browserReceivedCodec(page, "user-2", source)).toLowerCase();
  if (process.env.CI) expect(codec, "the native peer did not send VP9").toBe("video/vp9");
  else test.skip(codec !== "video/vp9", `the native peer sent ${codec}, not VP9`);
}

async function readBrowserPeer(page: import("@playwright/test").Page, identity: string) {
  return page.evaluate((identity) => {
    const state = (
      window as unknown as {
        __interop: {
          encErrors: number;
          reconnects: number;
          subscribed: string[];
          meters: Map<string, { sumSq: number; samples: number }>;
          videos: Map<string, { frames: number; width: number; height: number }>;
          shareAudio: Map<
            string,
            { sid: string; subscriptions: number; channels: number; left: number; right: number }
          >;
        };
      }
    ).__interop;
    const m = state.meters.get(identity);
    const a = state.shareAudio.get(identity);
    const v = state.videos.get(identity);
    return {
      encErrors: state.encErrors,
      reconnects: state.reconnects,
      subscribed: state.subscribed,
      rms: m && m.samples > 0 ? Math.sqrt(m.sumSq / m.samples) : 0,
      samples: m?.samples ?? 0,
      videoSubscribed: v !== undefined,
      videoFrames: v?.frames ?? 0,
      videoWidth: v?.width ?? 0,
      videoHeight: v?.height ?? 0,
      shareAudio: a ?? null,
    };
  }, identity);
}

/** Reset the browser meter so a reading covers only the window after now. */
async function resetBrowserMeters(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const state = (
      window as unknown as {
        __interop: {
          meters: Map<string, { sumSq: number; samples: number }>;
          videos: Map<string, { frames: number }>;
        };
      }
    ).__interop;
    for (const m of state.meters.values()) {
      m.sumSq = 0;
      m.samples = 0;
    }
    for (const v of state.videos.values()) v.frames = 0;
  });
}

/** Joins the browser peer as user-1 under a fresh key; returns the room's key and URL. */
async function joinRoom(
  page: import("@playwright/test").Page,
  video = false,
  videoCodec?: "vp9",
): Promise<{ key: string; url: string }> {
  const key = randomBytes(32).toString("base64");
  const url = `ws://127.0.0.1:${livekitPort}`;
  await joinBrowserPeer(page, url, joinToken("user-1"), key, video, videoCodec);
  return { key, url };
}

async function waitForVideoSubscribed(
  page: import("@playwright/test").Page,
  identity: string,
): Promise<void> {
  await expect
    .poll(async () => (await readBrowserPeer(page, identity)).videoSubscribed, {
      timeout: 60_000,
    })
    .toBe(true);
}

/** Frames decoded in each of `seconds` consecutive one-second windows. */
async function sampleFramesPerSecond(
  page: import("@playwright/test").Page,
  identity: string,
  seconds = 8,
): Promise<number[]> {
  const perSecond: number[] = [];
  for (let i = 0; i < seconds; i++) {
    await resetBrowserMeters(page);
    await page.waitForTimeout(1_000);
    perSecond.push((await readBrowserPeer(page, identity)).videoFrames);
  }
  return perSecond;
}

test("native and browser peers decode each other's audio with the same key", async ({ page }) => {
  const { key, url } = await joinRoom(page);

  const nativeAudio: Array<{ identity: string; rms: number; frames: number }> = [];
  const encryption: Array<{ identity: string; encrypted: boolean }> = [];
  const threads: Array<{ phase: string; count: number }> = [];
  const devices: Array<{ ok: boolean; detail: string }> = [];
  const playout: number[] = [];
  const peer = runNativePeer(
    [
      "--url",
      url,
      "--token",
      joinToken("user-2"),
      "--key",
      key,
      "--secs",
      "15",
      "--cycles",
      "5",
      "--mute-cycles",
      "10",
      "--volume",
      String(PEER_VOLUME),
    ],
    ({ event }) => {
      if (event.type === "audio")
        nativeAudio.push(event as unknown as { identity: string; rms: number; frames: number });
      if (event.type === "encryptionStatus")
        encryption.push(event as unknown as { identity: string; encrypted: boolean });
      if (event.type === "threads")
        threads.push(event as unknown as { phase: string; count: number });
      if (event.type === "devices")
        devices.push(event as unknown as { ok: boolean; detail: string });
      if (event.type === "playout") playout.push((event as unknown as { rms: number }).rms);
    },
  );

  // Let both sides settle (ICE, key exchange transients), then measure a clean window.
  await expect
    .poll(async () => (await readBrowserPeer(page, "user-2")).subscribed, { timeout: 60_000 })
    .toContain("user-2");
  await page.waitForTimeout(4_000);
  await resetBrowserMeters(page);
  await page.waitForTimeout(5_000);
  const browser = await readBrowserPeer(page, "user-2");
  await peer.done;

  // 1. Browser decodes the native sine at its exact RMS, with no decrypt errors.
  expect(browser.samples).toBeGreaterThan(0);
  expect(browser.rms).toBeGreaterThan(EXPECTED_SINE_RMS * 0.9);
  expect(browser.rms).toBeLessThan(EXPECTED_SINE_RMS * 1.1);
  expect(browser.encErrors).toBe(0);
  // 2. Native decodes the browser's fake microphone (Chromium's beep).
  const fromBrowser = nativeAudio.filter((a) => a.identity === "user-1");
  expect(fromBrowser.length).toBeGreaterThan(0);
  expect(Math.max(...fromBrowser.map((a) => a.rms))).toBeGreaterThan(100);
  // 3. The SDK reports the browser peer's frames as encrypted.
  expect(encryption).toContainEqual({
    type: "encryptionStatus",
    identity: "user-1",
    encrypted: true,
  });
  // Device enumeration ran without crashing; a headless runner has no sound
  //    server, so either outcome is recorded rather than asserted.
  expect(devices).toHaveLength(1);
  console.log(`native device enumeration: ok=${devices[0]!.ok} ${devices[0]!.detail}`);
  // 4. rust-sdks #1408: five join/leave cycles before the real join. Measured
  //    2026-09-22 with livekit 0.9.1: +2 threads per cycle with one remote
  //    participant (one leaked FrameCryptor thread per cryptor: ours and the
  //    peer's), idle threads with a few KiB of stack each. Recorded in
  //    docs/architecture/voice-e2ee.md; this pins that known rate so a worse
  //    leak (or a fix that lets the bound tighten) is visible.
  const before = threads.find((t) => t.phase === "before")!.count;
  const after = threads.find((t) => t.phase === "after")!.count;
  console.log(`native peer threads: before=${before} after 5 cycles=${after}`);
  expect(after - before).toBeLessThanOrEqual(2 * 5 + 2);
  // 5. Mute is in place (no republish, no new FrameCryptor): ten mute/unmute
  //    cycles leave the thread count flat, where a republish per unmute would
  //    leak at least one thread each. The slack covers runtime pool jitter.
  const muteBefore = threads.find((t) => t.phase === "mute-before")!.count;
  const muteAfter = threads.find((t) => t.phase === "mute-after")!.count;
  console.log(`native peer threads: before=${muteBefore} after 10 mute cycles=${muteAfter}`);
  expect(muteAfter - muteBefore).toBeLessThanOrEqual(2);
  // 7. Per-user volume: the playout mix carries the browser peer (the only
  //    remote) at PEER_VOLUME of its decoded level. Compared as energy over
  //    the settled seconds of each per-second meter; the beep's gaps and the
  //    two meters' unaligned windows are what the tolerance absorbs.
  const energy = (rms: number[]) =>
    Math.sqrt(rms.slice(3).reduce((sum, r) => sum + r * r, 0) / Math.max(1, rms.length - 3));
  const direct = energy(fromBrowser.map((a) => a.rms));
  const mixed = energy(playout);
  console.log(`native playout at volume ${PEER_VOLUME}: mixed=${mixed} direct=${direct}`);
  expect(playout.length).toBeGreaterThan(5);
  expect(mixed / direct).toBeGreaterThan(PEER_VOLUME * 0.7);
  expect(mixed / direct).toBeLessThan(PEER_VOLUME * 1.3);
});

test("a native peer with the wrong key hears silence and is heard as silence", async ({ page }) => {
  const { url } = await joinRoom(page);
  const wrongKey = randomBytes(32).toString("base64");

  const nativeAudio: Array<{ identity: string; rms: number; at: number }> = [];
  // Every peer event with its arrival time, so a run with no settled audio
  // says whether the meter never started, starved, or the peer left early.
  const timeline: Array<{ type: unknown; identity?: unknown; frames?: unknown; at: number }> = [];
  const peer = runNativePeer(nativePeerArgs(url, wrongKey, 12), ({ event }) => {
    timeline.push({
      type: event.type,
      identity: event.identity,
      frames: event.frames,
      at: Date.now(),
    });
    if (event.type === "audio")
      nativeAudio.push({
        ...(event as unknown as { identity: string; rms: number }),
        at: Date.now(),
      });
  });
  await expect
    .poll(async () => (await readBrowserPeer(page, "user-2")).subscribed, { timeout: 60_000 })
    .toContain("user-2");
  await page.waitForTimeout(3_000);
  await resetBrowserMeters(page);
  const settledAt = Date.now();
  await page.waitForTimeout(5_000);
  const browser = await readBrowserPeer(page, "user-2");
  await peer.done;

  expect(browser.samples).toBeGreaterThan(0);
  expect(browser.rms).toBeLessThan(0.005);
  expect(browser.encErrors).toBeGreaterThan(0);
  // Same settled window as the browser meter: livekit 0.9.1 attaches the
  // receiver FrameCryptor on TrackSubscribed, so the first frames can reach
  // the decoder still encrypted and decode as a burst of noise.
  const fromBrowser = nativeAudio.filter((a) => a.identity === "user-1" && a.at >= settledAt);
  // The native side subscribes to the browser track and decodes nothing
  // audible from it. Its meter reports only while decoded frames arrive: when
  // the cryptor is attached before the first frame, every frame is dropped and
  // there is nothing to report, which is silence too.
  const seen = timeline
    .map(
      (e) =>
        `${String(e.type)}${e.identity ? `:${String(e.identity)}` : ""}${e.frames === undefined ? "" : `#${String(e.frames)}`}@${e.at - settledAt}ms`,
    )
    .join(" ");
  expect(
    timeline.some((e) => e.type === "trackSubscribed" && e.identity === "user-1"),
    `native peer events relative to settle: ${seen}`,
  ).toBe(true);
  expect(
    fromBrowser.filter((a) => a.rms >= 1),
    `native peer events relative to settle: ${seen}`,
  ).toEqual([]);
});

type NativeVideo = { identity: string; frames: number; width: number; height: number; at: number };

test("native and browser peers decode each other's video with the same key", async ({ page }) => {
  const { key, url } = await joinRoom(page, true);

  const nativeVideo: NativeVideo[] = [];
  const socket: Array<Record<string, unknown>> = [];
  let resources: Record<string, number> = {};
  let closed: Record<string, unknown> = {};
  const threads: Array<{ phase: string; count: number }> = [];
  // Every peer event with its arrival time, so a run where the native side
  // decodes nothing says whether its watch never opened or opened and starved.
  const timeline: Array<{ type: unknown; at: number }> = [];
  const peer = runNativePeer(
    nativePeerArgs(url, key, 16, "--video", "640x360", "--camera-cycles", "5"),
    ({ event }) => {
      timeline.push({ type: event.type, at: Date.now() });
      if (event.type === "threads")
        threads.push(event as unknown as { phase: string; count: number });
      if (event.type === "video")
        nativeVideo.push({ ...(event as unknown as NativeVideo), at: Date.now() });
      if (event.type === "frameSocket") socket.push(event);
      if (event.type === "resources") resources = event.resources as Record<string, number>;
      if (event.type === "closed") closed = event;
    },
  );
  await waitForVideoSubscribed(page, "user-2");
  // Same reason as the screen-share test below: `videoSubscribed` fires on the
  // first publish, before the five camera stop/start cycles land, so measure
  // from the peer's settled `camera-after` phase, not from subscription.
  // Budget: the example waits up to 5 s for a subscriber to bind each of the
  // six cameras (the first plus five cycles), on top of join and publish.
  await expect
    .poll(() => threads.some((t) => t.phase === "camera-after"), { timeout: 60_000 })
    .toBe(true);
  await page.waitForTimeout(4_000);
  await resetBrowserMeters(page);
  const settledAt = Date.now();
  await page.waitForTimeout(5_000);
  const browser = await readBrowserPeer(page, "user-2");
  await peer.done;

  // The native camera (a synthetic source through the host's GStreamer
  // pipeline, VP8, E2EE) decodes in the browser at the published size and a
  // real frame rate, with no decrypt errors.
  console.log(
    `browser decoded native video: ${browser.videoFrames} frames in 5 s at ${browser.videoWidth}x${browser.videoHeight}`,
  );
  expect(browser.reconnects, "the SFU forced the browser peer to reconnect").toBe(0);
  expect(browser.videoFrames).toBeGreaterThan(5 * 10);
  expect([browser.videoWidth, browser.videoHeight]).toEqual([640, 360]);
  expect(browser.encErrors).toBe(0);
  // The browser's camera decodes natively and arrives through the frame socket.
  const fromBrowser = nativeVideo.filter((v) => v.identity === "user-1" && v.at >= settledAt);
  const perSecond = fromBrowser.map((v) => v.frames);
  console.log(`native decoded browser video, frames/s after settle: ${perSecond.join(",")}`);
  const seen = timeline.map((e) => `${String(e.type)}@${e.at - settledAt}ms`).join(" ");
  expect(fromBrowser.length, `native peer events relative to settle: ${seen}`).toBeGreaterThan(0);
  expect(Math.max(...perSecond)).toBeGreaterThan(10);
  expect(fromBrowser.at(-1)!.width).toBeGreaterThan(0);
  // The frame socket: loopback-bound, refuses a wrong or missing token, and
  // is torn down with the session.
  expect(socket).toEqual([
    expect.objectContaining({ loopback: true, wrongTokenRefused: true, noTokenRefused: true }),
  ]);
  expect(resources.localTracks).toBe(2);
  // One open socket: the native peer subscribes to the browser's camera only;
  // its own camera now captures in the host, so no webview upload socket.
  expect(resources.videoSockets).toBe(1);
  expect(resources.cameraCaptures).toBe(1);
  expect(closed.frameSocketGone).toBe(true);
  expect(closed.cameraCaptures).toBe(0);
  const camBefore = threads.find((t) => t.phase === "camera-before")!.count;
  const camAfter = threads.find((t) => t.phase === "camera-after")!.count;
  console.log(`native peer threads: before=${camBefore} after 5 camera cycles=${camAfter}`);
  // Each camera off/on unpublishes and republishes (as the web path does, so
  // remote tiles close), and each publish is a new sender. Measured
  // 2026-09-22 with livekit 0.9.1: +3 idle threads per cycle — the sender's
  // FrameCryptor thread (rust-sdks #1408) plus the VideoEncoderQueue and
  // VideoFrameTransformer threads it keeps alive. Pinned as the ceiling, as
  // for the join cycles above; docs/architecture/voice-e2ee.md records it.
  expect(camAfter - camBefore).toBeLessThanOrEqual(3 * 5 + 2);
});

test("a simulcast native camera keeps decoding in the browser", async ({ page }) => {
  // The app publishes its camera simulcast at every quality but "source",
  // 1280x720 for the default "high" preset (screenShare.ts), unlike the
  // 640x360 single-layer camera above.
  const { key, url } = await joinRoom(page);
  const peer = runNativePeer(nativePeerArgs(url, key, 20, "--video", "1280x720", "--simulcast"));
  await waitForVideoSubscribed(page, "user-2");
  await page.waitForTimeout(4_000);
  const perSecond = await sampleFramesPerSecond(page, "user-2");
  const browser = await readBrowserPeer(page, "user-2");
  await peer.done;
  console.log(
    `browser decoded simulcast native camera, frames/s: ${perSecond.join(",")} at ${browser.videoWidth}x${browser.videoHeight}`,
  );
  // Every second of the window, not just its total: a camera that sends one
  // frame and then stalls must fail here.
  expect(Math.min(...perSecond)).toBeGreaterThan(10);
  expect(browser.videoWidth).toBeGreaterThan(0);
  expect(browser.encErrors).toBe(0);
});

// Playwright's bundled Chromium has no H.264, so this case launches Google
// Chrome itself (GitHub-hosted Ubuntu runners ship it). It cannot be a
// describe with `test.use({ channel })` (Playwright refuses a channel there),
// and launching here leaves every other case's browser alone. Where Chrome is
// not installed it skips locally; in CI a missing Chrome fails.
const chromePath = "/opt/google/chrome/chrome";
test("a native H.264 camera decodes in the browser with the same key", async ({ playwright }) => {
  if (!process.env.CI)
    test.skip(!existsSync(chromePath), `Google Chrome is not installed at ${chromePath}`);
  // The picker enables H.264 only where the engine's probe says it can encode
  // it, so the probe decides here too: `--probe-codecs` prints it and exits.
  const probe = await runNativePeer(["--probe-codecs"]).done;
  const nativeH264 = probe.some((l) => l.event.type === "codecs" && l.event.h264 === true);
  // In CI a missing encoder is a failure: H.264 stays off the picker until
  // this case has run green there. Locally it skips with the reason.
  if (process.env.CI) expect(nativeH264, "the native engine cannot encode H.264").toBe(true);
  else test.skip(!nativeH264, "the native engine cannot encode H.264 in this build");
  const browser = await playwright.chromium
    .launch({
      channel: "chrome",
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    })
    .catch((err: unknown) => {
      throw new Error(`Google Chrome (channel "chrome") could not launch: ${String(err)}`);
    });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    const page = await context.newPage();
    const { key, url } = await joinRoom(page);
    const browserH264 = await page.evaluate(
      () =>
        RTCRtpReceiver.getCapabilities("video")?.codecs.some(
          (c) => c.mimeType.toLowerCase() === "video/h264",
        ) ?? false,
    );
    if (process.env.CI) expect(browserH264, "Google Chrome cannot decode H.264").toBe(true);
    else test.skip(!browserH264, "this browser cannot decode H.264");
    const peer = runNativePeer(
      nativePeerArgs(url, key, 20, "--video", "1280x720", "--simulcast", "--codec", "h264"),
    );
    await waitForVideoSubscribed(page, "user-2");
    await page.waitForTimeout(4_000);
    const perSecond = await sampleFramesPerSecond(page, "user-2");
    const seen = await readBrowserPeer(page, "user-2");
    await peer.done;
    console.log(
      `browser decoded H.264 native camera, frames/s: ${perSecond.join(",")} at ${seen.videoWidth}x${seen.videoHeight}`,
    );
    // Every second of the window: a camera that sends one frame and stalls fails.
    expect(Math.min(...perSecond)).toBeGreaterThan(10);
    expect(seen.videoWidth).toBeGreaterThan(0);
    // Decrypted with the same key: no frame failed its authentication.
    expect(seen.encErrors).toBe(0);
  } finally {
    await browser.close();
  }
});

// The native engine's VP9 decode, proven end to end: the browser publishes a
// VP9 camera and the native peer must decode it. `--probe-codecs` decides, as
// it does for H.264.
async function gateNativeVp9Decode(): Promise<void> {
  const probe = await runNativePeer(["--probe-codecs"]).done;
  const decodes = probe.some(
    (l) =>
      l.event.type === "codecs" &&
      Array.isArray(l.event.decode) &&
      (l.event.decode as unknown[]).includes("vp9"),
  );
  if (process.env.CI) expect(decodes, "the native engine cannot decode VP9").toBe(true);
  else test.skip(!decodes, "the native engine cannot decode VP9 in this build");
}

test("a browser VP9 camera decodes natively with the same key", async ({ page }) => {
  await gateNativeVp9Decode();
  const { key, url } = await joinRoom(page, true, "vp9");
  await expectBrowserVp9(page);

  const nativeVideo: NativeVideo[] = [];
  const peer = runNativePeer(nativePeerArgs(url, key, 16), ({ event }) => {
    if (event.type === "video")
      nativeVideo.push({ ...(event as unknown as NativeVideo), at: Date.now() });
  });
  await expect
    .poll(() => nativeVideo.some((v) => v.identity === "user-1" && v.frames > 0), {
      timeout: 60_000,
    })
    .toBe(true);
  const settledAt = Date.now();
  await page.waitForTimeout(5_000);
  const browser = await readBrowserPeer(page, "user-2");
  await peer.done;

  const fromBrowser = nativeVideo.filter((v) => v.identity === "user-1" && v.at >= settledAt);
  const perSecond = fromBrowser.map((v) => v.frames);
  console.log(`native decoded browser VP9 video, frames/s after settle: ${perSecond.join(",")}`);
  expect(fromBrowser.length).toBeGreaterThan(0);
  expect(Math.max(...perSecond)).toBeGreaterThan(10);
  expect(fromBrowser.at(-1)!.width).toBeGreaterThan(0);
  expect(browser.encErrors).toBe(0);
});

test("a browser VP9 camera with the wrong key decodes no VP9 frame natively", async ({ page }) => {
  await gateNativeVp9Decode();
  const { url } = await joinRoom(page, true, "vp9");
  const wrongKey = randomBytes(32).toString("base64");
  await expectBrowserVp9(page);

  const nativeVideo: NativeVideo[] = [];
  const watching: string[] = [];
  const peer = runNativePeer(nativePeerArgs(url, wrongKey, 14), ({ event }) => {
    if (event.type === "video")
      nativeVideo.push({ ...(event as unknown as NativeVideo), at: Date.now() });
    if (event.type === "videoWatch") watching.push(String(event.identity));
  });
  await expect.poll(() => watching.includes("user-1"), { timeout: 60_000 }).toBe(true);
  const settledAt = Date.now();
  await page.waitForTimeout(5_000);
  await peer.done;

  const fromBrowser = nativeVideo.filter((v) => v.identity === "user-1" && v.at >= settledAt);
  expect(fromBrowser.reduce((sum, v) => sum + v.frames, 0)).toBe(0);
});

// A native VP9 publish (WP M-11b) is one L1T3 SVC layer. The camera still asks
// for `--simulcast`; the Rust unit test proves the host drops it for VP9.
test("a native VP9 camera decodes in the browser with the same key", async ({ page }) => {
  await gateNativeVp9Encode();
  const { key, url } = await joinRoom(page);
  const peer = runNativePeer(
    nativePeerArgs(url, key, 20, "--video", "1280x720", "--simulcast", "--codec", "vp9"),
  );
  await waitForVideoSubscribed(page, "user-2");
  await page.waitForTimeout(4_000);
  await expectBrowserReceivedVp9(page, "camera");
  const perSecond = await sampleFramesPerSecond(page, "user-2");
  const seen = await readBrowserPeer(page, "user-2");
  await peer.done;
  console.log(
    `browser decoded VP9 native camera, frames/s: ${perSecond.join(",")} at ${seen.videoWidth}x${seen.videoHeight}`,
  );
  // Every second of the window: a camera that sends one frame and stalls fails.
  expect(Math.min(...perSecond)).toBeGreaterThan(10);
  expect([seen.videoWidth, seen.videoHeight]).toEqual([1280, 720]);
  expect(seen.encErrors).toBe(0);
});

test("a native VP9 screen share decodes in the browser with the same key", async ({ page }) => {
  await gateNativeVp9Encode();
  const { key, url } = await joinRoom(page);
  const peer = runNativePeer(
    nativePeerArgs(url, key, 16, "--screen", "1280x720", "--screen-codec", "vp9"),
  );
  await waitForVideoSubscribed(page, "user-2#screen");
  await page.waitForTimeout(4_000);
  await expectBrowserReceivedVp9(page, "screen_share");
  await resetBrowserMeters(page);
  await page.waitForTimeout(5_000);
  const browser = await readBrowserPeer(page, "user-2#screen");
  await peer.done;
  console.log(
    `browser decoded VP9 native screen share: ${browser.videoFrames} frames in 5 s at ${browser.videoWidth}x${browser.videoHeight}`,
  );
  expect(browser.videoFrames).toBeGreaterThan(5 * 5);
  expect([browser.videoWidth, browser.videoHeight]).toEqual([1280, 720]);
  expect(browser.encErrors).toBe(0);
});

test("a native VP9 camera and share with the wrong key are decoded by no one", async ({ page }) => {
  await gateNativeVp9Encode();
  const { url } = await joinRoom(page);
  const wrongKey = randomBytes(32).toString("base64");
  const peer = runNativePeer(
    nativePeerArgs(
      url,
      wrongKey,
      14,
      "--video",
      "640x360",
      "--codec",
      "vp9",
      "--screen",
      "1280x720",
      "--screen-codec",
      "vp9",
    ),
  );
  await waitForVideoSubscribed(page, "user-2");
  await waitForVideoSubscribed(page, "user-2#screen");
  await page.waitForTimeout(3_000);
  await resetBrowserMeters(page);
  await page.waitForTimeout(5_000);
  const camera = await readBrowserPeer(page, "user-2");
  const screen = await readBrowserPeer(page, "user-2#screen");
  // The codec is unreadable when nothing decrypts; the same-key cases above
  // prove this exact publish goes out as VP9.
  await peer.done;
  // Subscribed to both, and not one frame of either decoded.
  expect(camera.videoFrames).toBe(0);
  expect(screen.videoFrames).toBe(0);
  expect(camera.encErrors).toBeGreaterThan(0);
  expect(screen.encErrors).toBeGreaterThan(0);
});

test("a native peer with the wrong key decodes no video and is decoded by no one", async ({
  page,
}) => {
  const { url } = await joinRoom(page, true);
  const wrongKey = randomBytes(32).toString("base64");

  const nativeVideo: NativeVideo[] = [];
  const watching: string[] = [];
  const peer = runNativePeer(
    nativePeerArgs(url, wrongKey, 14, "--video", "640x360"),
    ({ event }) => {
      if (event.type === "video")
        nativeVideo.push({ ...(event as unknown as NativeVideo), at: Date.now() });
      if (event.type === "videoWatch") watching.push(String(event.identity));
    },
  );
  await waitForVideoSubscribed(page, "user-2");
  await page.waitForTimeout(3_000);
  await resetBrowserMeters(page);
  const settledAt = Date.now();
  await page.waitForTimeout(5_000);
  const browser = await readBrowserPeer(page, "user-2");
  await peer.done;

  // Same settled window as the audio control: receiver cryptors attach on
  // TrackSubscribed, so frames before it are not the measurement.
  expect(browser.videoFrames).toBe(0);
  expect(browser.encErrors).toBeGreaterThan(0);
  // The native side subscribed and opened its frame socket, and not one
  // frame of the browser's camera decoded.
  expect(watching).toContain("user-1");
  const fromBrowser = nativeVideo.filter((v) => v.identity === "user-1" && v.at >= settledAt);
  expect(fromBrowser.reduce((sum, v) => sum + v.frames, 0)).toBe(0);
});

test("a native screen share decodes in the browser with the same key", async ({ page }) => {
  const { key, url } = await joinRoom(page);

  const nativeVideo: NativeVideo[] = [];
  let resources: Record<string, number> = {};
  let closed: Record<string, unknown> = {};
  const threads: Array<{ phase: string; count: number; fds: number; captures: number }> = [];
  const peer = runNativePeer(
    nativePeerArgs(url, key, 16, "--screen", "1280x720", "--screen-cycles", "5"),
    ({ event }) => {
      if (event.type === "threads")
        threads.push(
          event as unknown as { phase: string; count: number; fds: number; captures: number },
        );
      if (event.type === "video")
        nativeVideo.push({ ...(event as unknown as NativeVideo), at: Date.now() });
      if (event.type === "resources") resources = event.resources as Record<string, number>;
      if (event.type === "closed") closed = event;
    },
  );
  await waitForVideoSubscribed(page, "user-2#screen");
  // `videoSubscribed` turns true on the first publish, which precedes the five
  // stop/start cycles. Measuring from there could land the window inside the
  // churn (observed: "0 frames in 5 s at 0x0", passing on retry). The peer
  // emits `screen-after` once the last capture is live and settled, so wait for
  // it and measure only the steady state the test is about.
  await expect
    .poll(() => threads.some((t) => t.phase === "screen-after"), { timeout: 30_000 })
    .toBe(true);
  await page.waitForTimeout(4_000);
  await resetBrowserMeters(page);
  await page.waitForTimeout(5_000);
  const browser = await readBrowserPeer(page, "user-2#screen");
  await peer.done;

  // The share (15 fps, screencast content, VP8, E2EE) decodes at its size.
  console.log(
    `browser decoded native screen share: ${browser.videoFrames} frames in 5 s at ${browser.videoWidth}x${browser.videoHeight}`,
  );
  expect(browser.videoFrames).toBeGreaterThan(5 * 5);
  expect([browser.videoWidth, browser.videoHeight]).toEqual([1280, 720]);
  expect(browser.encErrors).toBe(0);
  // The local preview arrives on the frame socket's screen route.
  const preview = nativeVideo.filter((v) => v.identity === "preview");
  expect(preview.length).toBeGreaterThan(0);
  expect(Math.max(...preview.map((v) => v.frames))).toBeGreaterThan(5);
  expect([preview.at(-1)!.width, preview.at(-1)!.height]).toEqual([1280, 720]);
  // Five stop/start cycles leave exactly the live capture, published (mic +
  // screen), and a stale stop did not end it; close releases it.
  const before = threads.find((t) => t.phase === "screen-before")!;
  const after = threads.find((t) => t.phase === "screen-after")!;
  expect(before.captures).toBe(1);
  expect(after.captures).toBe(1);
  expect(resources.screenCaptures).toBe(1);
  expect(resources.localTracks).toBe(2);
  expect(closed.screenCaptures).toBe(0);
  console.log(
    `native peer threads: before=${before.count} after 5 screen share cycles=${after.count}; fds ${before.fds} -> ${after.fds}`,
  );
  // Like a camera toggle, each share is a new sender, whose idle threads
  // livekit 0.9.1 keeps until the room closes (rust-sdks #1408 family).
  // Measured 2026-09-23: +3.5 to +4.6 per cycle — one FrameCryptor and one
  // VideoFrameTransformer thread per sender plus one or two
  // VideoEncoderQueue threads (the screencast encoder can restart once).
  // The capture thread itself is joined on stop and adds nothing, and file
  // descriptors stay flat. Pinned as the ceiling; docs/architecture/voice-e2ee.md
  // records it. Closing the room releases all but each sender's
  // FrameCryptor thread (#1408 proper).
  expect(after.count - before.count).toBeLessThanOrEqual(5 * 5 + 2);
  expect(closed.threads as number).toBeLessThan(after.count);
  expect(after.fds - before.fds).toBeLessThanOrEqual(2);
});

// WP LP-8b: the share's audio, from a synthetic stereo source (CI has no
// sound server; the capture module has its own tests), published through the
// same options as the app. The browser decodes it with the right key, and the
// video republish a codec change causes leaves it published and decoding.
test("a native screen share's audio decodes in the browser and survives a video republish", async ({
  page,
}) => {
  const { key, url } = await joinRoom(page);

  const events: Array<Record<string, unknown> & { type: string }> = [];
  const peer = runNativePeer(
    nativePeerArgs(
      url,
      key,
      30,
      "--screen",
      "1280x720",
      "--screen-audio",
      "--screen-audio-cycles",
      "3",
      "--republish-screen",
    ),
    ({ event }) => {
      events.push(event);
    },
  );
  const audio = "user-2#screenaudio";
  await expect
    .poll(async () => (await readBrowserPeer(page, audio)).samples, { timeout: 60_000 })
    .toBeGreaterThan(0);
  const published = () => events.find((e) => e.type === "screenAudio" && e.phase === "published");
  await expect.poll(() => published() !== undefined, { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(2_000);
  await resetBrowserMeters(page);
  await page.waitForTimeout(3_000);
  const before = await readBrowserPeer(page, audio);
  expect(before.rms, "the audio decodes with the right key before the republish").toBeGreaterThan(
    0.01,
  );
  // LP-8d: the vendored SDK signals stereo for the share audio, so the
  // publisher's opus is stereo; the channel count the browser reports for the
  // track is logged, the stereo assertions are the LP-8d test's and below.
  console.log(
    `browser decoded native screen-share audio: rms ${before.rms.toFixed(3)}, ` +
      `channelCount ${before.shareAudio?.channels}, peak left ${before.shareAudio?.left.toFixed(3)} ` +
      `right ${before.shareAudio?.right.toFixed(3)}`,
  );

  // The video republish (about 6 s after the audio published) keeps the same
  // audio publication: same sid, one subscription, still decoding.
  await expect
    .poll(() => events.some((e) => e.type === "screenAudio" && e.phase === "after-republish"), {
      timeout: 30_000,
    })
    .toBe(true);
  await page.waitForTimeout(2_000);
  await resetBrowserMeters(page);
  await page.waitForTimeout(3_000);
  const after = await readBrowserPeer(page, audio);
  await peer.done;
  // LP-8d: the video republish renegotiates the publisher, and the share
  // audio keeps stereo=1 through it. (A full reconnect republishes with the
  // stored publish options; that path is covered by reading, not here.)
  const republished = events.find((e) => e.type === "screenAudio" && e.phase === "after-republish");
  expect(republished?.channels, "the share audio is still stereo after the republish").toBe(2);
  expect(String(republished?.sdpFmtpLine), "stereo=1 survives the republish").toContain("stereo=1");
  expect(after.shareAudio?.sid).toBe(before.shareAudio?.sid);
  expect(after.shareAudio?.sid).toBe(published()?.sid);
  // The cycles before it subscribed earlier publications; the republish adds none.
  expect(after.shareAudio?.subscriptions).toBe(before.shareAudio?.subscriptions);
  expect(after.rms, "the audio still decodes after the video republish").toBeGreaterThan(0.01);
  expect(after.encErrors).toBe(0);

  // Each capture-fed publish cycle starts and joins the capture thread, and
  // adds a sender: libwebrtc keeps two per-sender threads (AudioEncoderQueue
  // and FrameCryptorTransformer) until the room closes. So the ceiling is per
  // cycle, not flat.
  const threads = events.filter((e) => e.type === "threads");
  const t0 = threads.find((t) => t.phase === "screen-audio-before")!;
  const t1 = threads.find((t) => t.phase === "screen-audio-after")!;
  console.log(`native peer threads: before=${t0.count} after 3 share-audio cycles=${t1.count}`);
  expect((t1.count as number) - (t0.count as number)).toBeLessThanOrEqual(3 * 3 + 2);
  expect((t1.fds as number) - (t0.fds as number)).toBeLessThanOrEqual(2);

  // Stopping the share releases the video and its audio together: the
  // session held mic + video + audio (3) and now holds the mic only, and no
  // capture is left running.
  const stopped = events.find((e) => e.type === "screenStopped")!;
  const held = stopped.before as Record<string, number>;
  const left = stopped.after as Record<string, number>;
  expect(held.localTracks, "mic, screen video and its audio before the stop").toBe(3);
  expect(left.localTracks).toBe(1);
  expect(left.screenCaptures).toBe(0);
});

// WP LP-8d: does a Linux share's audio reach a viewer as stereo? The native
// source puts 440 Hz on the left and 660 Hz on the right. The assertion is the
// outcome we want (stereo negotiated, channels kept apart); a failure prints
// the negotiated fmtp line and the per-channel peaks, so CI shows the real
// state without a hand test.
test("a native share's audio reaches the browser as stereo with the channels apart", async ({
  page,
}) => {
  const key = randomBytes(32).toString("base64");
  const url = `ws://127.0.0.1:${livekitPort}`;
  const events: Array<Record<string, unknown> & { type: string }> = [];
  await joinBrowserPeer(page, url, joinToken("user-1"), key);

  const peer = runNativePeer(
    nativePeerArgs(url, key, 25, "--screen", "1280x720", "--screen-audio"),
    ({ event }) => {
      events.push(event);
    },
  );
  await expect
    .poll(async () => (await readBrowserPeer(page, "user-2#screenaudio")).samples, {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  await page.waitForTimeout(2_000);

  const reading = await page.evaluate(async () => {
    const room = (window as unknown as { __room: import("livekit-client").Room }).__room;
    const lk = (window as unknown as { LivekitClient: typeof import("livekit-client") })
      .LivekitClient;
    const remote = [...room.remoteParticipants.values()].find((p) => p.identity === "user-2");
    const pub = remote?.getTrackPublication(lk.Track.Source.ScreenShareAudio);
    const track = pub?.track;
    if (track === undefined) return null;

    // (a) The negotiated codec of the inbound audio.
    let fmtp = "";
    let channels = 0;
    const report = await track.getRTCStatsReport();
    report?.forEach((s: { type: string; kind?: string; codecId?: string }) => {
      if (s.type !== "inbound-rtp" || s.kind !== "audio" || s.codecId === undefined) return;
      const codec = report.get(s.codecId) as
        { sdpFmtpLine?: string; channels?: number } | undefined;
      fmtp = codec?.sdpFmtpLine ?? "";
      channels = codec?.channels ?? 0;
    });

    // (b) The dominant frequency of each channel of the received track.
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    const source = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    const splitter = ctx.createChannelSplitter(2);
    source.connect(splitter);
    const analysers = [ctx.createAnalyser(), ctx.createAnalyser()];
    analysers.forEach((a, i) => {
      a.fftSize = 8192;
      splitter.connect(a, i);
    });
    const best = [
      { hz: 0, db: -Infinity },
      { hz: 0, db: -Infinity },
    ];
    // Each channel's level at the two source tones (the strongest of the bin
    // and its neighbours over the whole window): the left must hold 440 Hz and
    // lack 660 Hz, the right the reverse. A mono downmix has both tones, at
    // the same level, in both channels.
    const tone = [
      { at440: -Infinity, at660: -Infinity },
      { at440: -Infinity, at660: -Infinity },
    ];
    for (let n = 0; n < 30; n++) {
      await new Promise((r) => setTimeout(r, 100));
      analysers.forEach((a, i) => {
        const bins = new Float32Array(a.frequencyBinCount);
        a.getFloatFrequencyData(bins);
        let top = 0;
        for (let b = 1; b < bins.length; b++) if (bins[b]! > bins[top]!) top = b;
        if (bins[top]! > best[i]!.db)
          best[i] = { hz: (top * ctx.sampleRate) / a.fftSize, db: bins[top]! };
        const level = (hz: number) => {
          const c = Math.round((hz * a.fftSize) / ctx.sampleRate);
          return Math.max(bins[c - 1]!, bins[c]!, bins[c + 1]!);
        };
        tone[i]!.at440 = Math.max(tone[i]!.at440, level(440));
        tone[i]!.at660 = Math.max(tone[i]!.at660, level(660));
      });
    }
    await ctx.close();
    return { fmtp, channels, left: best[0]!, right: best[1]!, tone };
  });
  await peer.done;

  expect(reading, "the browser has the native share audio track").not.toBeNull();
  const { fmtp, channels, left, right, tone } = reading!;
  const [leftTone, rightTone] = [tone[0]!, tone[1]!];
  const published = events.find((e) => e.type === "screenAudio" && e.phase === "published");
  const state =
    `sdpFmtpLine="${fmtp}" codec channels=${channels} ` +
    `left peak ${left.hz.toFixed(0)} Hz (${left.db.toFixed(0)} dB) ` +
    `right peak ${right.hz.toFixed(0)} Hz (${right.db.toFixed(0)} dB) ` +
    `left 440/660 ${leftTone.at440.toFixed(0)}/${leftTone.at660.toFixed(0)} dB ` +
    `right 440/660 ${rightTone.at440.toFixed(0)}/${rightTone.at660.toFixed(0)} dB ` +
    `publisher channels=${String(published?.channels)} fmtp="${String(published?.sdpFmtpLine)}"`;
  console.log(`LP-8d native share audio as received: ${state}`);
  expect(fmtp, `stereo=1 is negotiated for the share audio: ${state}`).toContain("stereo=1");
  expect(channels, `the opus codec is stereo: ${state}`).toBe(2);
  expect(Math.abs(left.hz - 440), `left channel carries 440 Hz: ${state}`).toBeLessThan(30);
  expect(Math.abs(right.hz - 660), `right channel carries 660 Hz: ${state}`).toBeLessThan(30);
  // Publisher side: the native sender itself negotiated stereo opus, so the
  // channels were never downmixed before they left.
  expect(published?.channels, `the publisher's opus is stereo: ${state}`).toBe(2);
  expect(String(published?.sdpFmtpLine), `the publisher's fmtp has stereo=1: ${state}`).toContain(
    "stereo=1",
  );
  // Downmix versus duplicate: with the channels truly apart, each side's other
  // tone sits at least 20 dB below its own.
  expect(
    leftTone.at440 - leftTone.at660,
    `left 660 Hz is 20 dB under its 440 Hz: ${state}`,
  ).toBeGreaterThanOrEqual(20);
  expect(
    rightTone.at660 - rightTone.at440,
    `right 440 Hz is 20 dB under its 660 Hz: ${state}`,
  ).toBeGreaterThanOrEqual(20);
});

// WP M-12a: a live quality change re-caps the running capture and republishes
// it (livekit 0.9.5 cannot change a sender's encoding). The browser re-subscribes
// at the new size with the same key, and the share audio keeps flowing.
test("a native share changes quality live and keeps decoding in the browser", async ({ page }) => {
  const { key, url } = await joinRoom(page);

  const events: Array<Record<string, unknown> & { type: string }> = [];
  const peer = runNativePeer(
    nativePeerArgs(
      url,
      key,
      30,
      "--screen",
      "1280x720",
      "--screen-audio",
      "--screen-quality-after",
      "8",
    ),
    ({ event }) => {
      events.push(event);
    },
  );
  await waitForVideoSubscribed(page, "user-2#screen");
  // The share audio, subscribed before the change (it is published at once;
  // the change comes 8 s later).
  await expect
    .poll(async () => (await readBrowserPeer(page, "user-2#screenaudio")).shareAudio !== null, {
      timeout: 30_000,
    })
    .toBe(true);
  const audioBefore = (await readBrowserPeer(page, "user-2#screenaudio")).shareAudio!;
  const changed = () => events.find((e) => e.type === "screenQuality");
  await expect.poll(() => changed() !== undefined, { timeout: 40_000 }).toBe(true);
  expect([changed()!.width, changed()!.height]).toEqual([640, 360]);
  // A new publication, not the old one resized: viewers get a new sid.
  expect(changed()!.sid).not.toBe(changed()!.previousSid);
  // The session still holds the mic, the republished video and the share
  // audio, which the quality change leaves alone.
  expect((changed()!.resources as Record<string, number>).localTracks).toBe(3);
  // The republish is a new sender: let the browser subscribe to it.
  await page.waitForTimeout(5_000);
  await resetBrowserMeters(page);
  await page.waitForTimeout(5_000);
  const video = await readBrowserPeer(page, "user-2#screen");
  const audio = await readBrowserPeer(page, "user-2#screenaudio");
  await peer.done;

  console.log(
    `browser decoded the changed native share: ${video.videoFrames} frames in 5 s at ${video.videoWidth}x${video.videoHeight}`,
  );
  expect(video.videoFrames).toBeGreaterThan(5 * 5);
  expect([video.videoWidth, video.videoHeight]).toEqual([640, 360]);
  expect(video.encErrors).toBe(0);
  expect(audio.rms, "the share audio keeps decoding across the quality change").toBeGreaterThan(
    0.01,
  );
  expect(audio.encErrors).toBe(0);
  // The video republish adds no audio publication or subscription.
  expect(audio.shareAudio?.sid).toBe(audioBefore.sid);
  expect(audio.shareAudio?.subscriptions).toBe(audioBefore.subscriptions);
});

test("a native screen share's audio with the wrong key is decoded as silence", async ({ page }) => {
  const { url } = await joinRoom(page);
  const wrongKey = randomBytes(32).toString("base64");

  const peer = runNativePeer(
    nativePeerArgs(url, wrongKey, 14, "--screen", "1280x720", "--screen-audio"),
  );
  await expect
    .poll(async () => (await readBrowserPeer(page, "user-2#screenaudio")).samples, {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  await page.waitForTimeout(3_000);
  await resetBrowserMeters(page);
  await page.waitForTimeout(5_000);
  const browser = await readBrowserPeer(page, "user-2#screenaudio");
  await peer.done;
  // `encErrors` also counts the video's errors, so it proves nothing about
  // the audio; the audio-specific assertion is the silence below.
  expect(browser.rms).toBeLessThan(0.001);
  expect(browser.encErrors).toBeGreaterThan(0);
});

test("a native screen share with the wrong key is decoded by no one", async ({ page }) => {
  const { url } = await joinRoom(page);
  const wrongKey = randomBytes(32).toString("base64");

  const peer = runNativePeer(nativePeerArgs(url, wrongKey, 14, "--screen", "1280x720"));
  await waitForVideoSubscribed(page, "user-2#screen");
  await page.waitForTimeout(3_000);
  await resetBrowserMeters(page);
  await page.waitForTimeout(5_000);
  const browser = await readBrowserPeer(page, "user-2#screen");
  await peer.done;

  // Subscribed to the share, and not one frame of it decoded.
  expect(browser.videoFrames).toBe(0);
  expect(browser.encErrors).toBeGreaterThan(0);
});

// The silent-crash report (#2095): on Linux the app died with camera and
// screen share on together, in the same process. This runs the native camera
// and screen capture pipelines together, alongside E2EE, for a few minutes
// and asserts both decode and the process closes cleanly. It is the soak the
// PR asks for; a crash log line would be the crash's evidence, not a fix.
test("native camera and screen share run together with E2EE and close cleanly", async ({
  page,
}) => {
  const { key, url } = await joinRoom(page, true);

  let resources: Record<string, number> = {};
  let closed: Record<string, unknown> = {};
  const peer = runNativePeer(
    nativePeerArgs(url, key, 150, "--video", "640x360", "--screen", "1280x720"),
    ({ event }) => {
      if (event.type === "resources") resources = event.resources as Record<string, number>;
      if (event.type === "closed") closed = event;
    },
  );
  await waitForVideoSubscribed(page, "user-2");
  await waitForVideoSubscribed(page, "user-2#screen");
  await page.waitForTimeout(4_000);
  await resetBrowserMeters(page);
  // Both pipelines stay live for the soak window.
  await page.waitForTimeout(20_000);
  const camera = await readBrowserPeer(page, "user-2");
  const screen = await readBrowserPeer(page, "user-2#screen");
  expect(camera.videoFrames).toBeGreaterThan(20 * 5);
  expect(screen.videoFrames).toBeGreaterThan(20 * 3);
  expect(camera.encErrors).toBe(0);
  expect(screen.encErrors).toBe(0);
  // The process closes cleanly with both captures released.
  await peer.done;
  expect(resources.cameraCaptures).toBe(1);
  expect(resources.screenCaptures).toBe(1);
  expect(closed.cameraCaptures).toBe(0);
  expect(closed.screenCaptures).toBe(0);
});
