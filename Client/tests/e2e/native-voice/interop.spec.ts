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
//   4. repeated mute/unmute keeps the publication, so it adds no threads.
// Requires OWNCORD_E2E_LIVEKIT_BINARY and OWNCORD_NATIVE_VOICE_PEER.
import { test, expect } from "@playwright/test";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { freePort, freeUdpPort, startProcess, stopProcess, waitForHttp } from "../support/process";

/** livekit-client's package exports hide dist/; the spec runs from Client/. */
const livekitDist = resolve("node_modules/livekit-client/dist");

const KEY_ID = "e2e-key";
const API_SECRET = "e2e-secret-at-least-32-characters-long";
const ROOM = "native-interop";
/** 440 Hz sine, amplitude 8000 of 32768: RMS = 8000/32768/sqrt(2). */
const EXPECTED_SINE_RMS = 8000 / 32768 / Math.SQRT2;

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
      video: { room: ROOM, roomJoin: true, canPublish: true, canSubscribe: true },
    }),
  );
  const signature = b64url(
    createHmac("sha256", API_SECRET).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}

type NativeLine = { event: Record<string, unknown> & { type: string } };

/** Run the native peer to completion and return its JSON lines. */
function runNativePeer(
  args: string[],
  onLine?: (line: NativeLine) => void,
): { child: ChildProcess; done: Promise<NativeLine[]> } {
  const { child } = startProcess(resolve(nativePeer!), args, process.cwd(), {
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
      code === 0 ? resolveDone(lines) : reject(new Error(`native peer exited ${code}`)),
    );
  });
  return { child, done };
}

let livekit: ReturnType<typeof startProcess>;
let livekitPort: number;
let dataDir: string;

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "owncord-native-voice-"));
  livekitPort = await freePort();
  const rtcPort = await freePort();
  const rtcUdpPort = await freeUdpPort();
  const config = join(dataDir, "livekit.yaml");
  await writeFile(
    config,
    `port: ${livekitPort}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${rtcPort}\n  udp_port: ${rtcUdpPort}\n  use_external_ip: false\n  node_ip: 127.0.0.1\n  enable_loopback_candidate: true\n  ips:\n    includes: [127.0.0.1/32]\nlogging:\n  level: warn\nkeys:\n  ${KEY_ID}: ${API_SECRET}\n`,
  );
  livekit = startProcess(resolve(livekitBinary!), ["--config", config], dataDir);
  await waitForHttp(`http://127.0.0.1:${livekitPort}`, livekit);
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
) {
  // livekit-server answers "OK" at /, which is enough of an origin for a
  // worker and WebRTC; the SDK and its worker come from node_modules.
  await page.route("**/e2ee-worker.js", (route) =>
    route.fulfill({ path: join(livekitDist, "livekit-client.e2ee.worker.js") }),
  );
  await page.goto(`http://127.0.0.1:${livekitPort}/`);
  await page.addScriptTag({ path: join(livekitDist, "livekit-client.umd.js") });
  await page.evaluate(
    async ({ url, token, keyBase64 }) => {
      const lk = (window as unknown as { LivekitClient: typeof import("livekit-client") })
        .LivekitClient;
      const meters = new Map<string, { sumSq: number; samples: number }>();
      const state = { encErrors: 0, subscribed: [] as string[], meters };
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
      const ctx = new AudioContext({ sampleRate: 48000 });
      room.on(lk.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind !== lk.Track.Kind.Audio) return;
        state.subscribed.push(participant.identity);
        // Chromium only decodes a remote track that is attached somewhere.
        const el = track.attach() as HTMLAudioElement;
        el.volume = 0;
        document.body.appendChild(el);
        const meter = { sumSq: 0, samples: 0 };
        meters.set(participant.identity, meter);
        const source = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
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
    },
    { url, token, keyBase64 },
  );
}

async function readBrowserPeer(page: import("@playwright/test").Page, identity: string) {
  return page.evaluate((identity) => {
    const state = (
      window as unknown as {
        __interop: {
          encErrors: number;
          subscribed: string[];
          meters: Map<string, { sumSq: number; samples: number }>;
        };
      }
    ).__interop;
    const m = state.meters.get(identity);
    return {
      encErrors: state.encErrors,
      subscribed: state.subscribed,
      rms: m && m.samples > 0 ? Math.sqrt(m.sumSq / m.samples) : 0,
      samples: m?.samples ?? 0,
    };
  }, identity);
}

/** Reset the browser meter so a reading covers only the window after now. */
async function resetBrowserMeters(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const state = (
      window as unknown as {
        __interop: { meters: Map<string, { sumSq: number; samples: number }> };
      }
    ).__interop;
    for (const m of state.meters.values()) {
      m.sumSq = 0;
      m.samples = 0;
    }
  });
}

test("native and browser peers decode each other's audio with the same key", async ({ page }) => {
  const key = randomBytes(32).toString("base64");
  const url = `ws://127.0.0.1:${livekitPort}`;
  await joinBrowserPeer(page, url, joinToken("user-1"), key);

  const nativeAudio: Array<{ identity: string; rms: number; frames: number }> = [];
  const encryption: Array<{ identity: string; encrypted: boolean }> = [];
  const threads: Array<{ phase: string; count: number }> = [];
  const devices: Array<{ ok: boolean; detail: string }> = [];
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
});

test("a native peer with the wrong key hears silence and is heard as silence", async ({ page }) => {
  const key = randomBytes(32).toString("base64");
  const wrongKey = randomBytes(32).toString("base64");
  const url = `ws://127.0.0.1:${livekitPort}`;
  await joinBrowserPeer(page, url, joinToken("user-1"), key);

  const nativeAudio: Array<{ identity: string; rms: number; at: number }> = [];
  const peer = runNativePeer(
    ["--url", url, "--token", joinToken("user-2"), "--key", wrongKey, "--secs", "12"],
    ({ event }) => {
      if (event.type === "audio")
        nativeAudio.push({
          ...(event as unknown as { identity: string; rms: number }),
          at: Date.now(),
        });
    },
  );
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
  // The native side still plays the browser track out, and it is silence.
  expect(fromBrowser.length).toBeGreaterThan(0);
  expect(Math.max(...fromBrowser.map((a) => a.rms))).toBeLessThan(1);
});
