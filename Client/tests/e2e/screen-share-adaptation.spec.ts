import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { ScreenShareCaptureOptions } from "livekit-client";

// Full Chromium supports real tab capture in headless mode; the separate
// headless-shell binary does not. No fake media tracks or mocked stats.
test.use({
  channel: "chromium",
  viewport: { width: 2560, height: 1440 },
  launchOptions: {
    args: [
      "--auto-accept-this-tab-capture",
      "--enable-usermedia-screen-capturing",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  },
});

// A four-minute benchmark on a real software encoder: too heavy and
// timing-sensitive for the required mock suite's shared runners, where any
// other load costs it frames. Run it on a quiet machine on demand.
test.skip(!process.env.OWNCORD_SHARE_BENCH, "set OWNCORD_SHARE_BENCH=1 to run the share benchmark");

test("VP8 motion capture lowers resolution under a constrained bitrate budget and recovers after", async ({
  page,
}, testInfo) => {
  test.setTimeout(270_000);
  await page.route("**/motion-probe", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<title>OwnCord Motion Probe</title><style>body{margin:0;overflow:hidden}</style><canvas width="2560" height="1440"></canvas>',
    }),
  );
  await page.goto("/motion-probe");

  const results = [];
  for (const fixed of [false, true]) {
    const result = await page.evaluate(async (applyFix) => {
      const presetsUrl = "/src/lib/voice/videoPresets.ts";
      const sdkUrl = "/node_modules/livekit-client/dist/livekit-client.esm.mjs";
      const presets: {
        getScreenShareCaptureOptions(quality: "source", fps: number): ScreenShareCaptureOptions;
        applyScreenShareContentHint(
          track: MediaStreamTrack,
          options: ScreenShareCaptureOptions,
          codec: "vp8",
        ): void;
      } = await import(presetsUrl);
      const recoveryUrl = "/src/lib/voice/shareResolutionRecovery.ts";
      const recovery: typeof import("../../src/lib/voice/shareResolutionRecovery") = await import(
        recoveryUrl
      );
      const sdk: typeof import("livekit-client") = await import(sdkUrl);
      const canvas = document.querySelector("canvas")!;
      const ctx = canvas.getContext("2d")!;
      const texture = document.createElement("canvas");
      texture.width = 640;
      texture.height = 360;
      const textureCtx = texture.getContext("2d")!;
      let seed = 12345;
      for (let y = 0; y < 360; y += 8) {
        for (let x = 0; x < 640; x += 8) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          textureCtx.fillStyle = `rgb(${seed & 255},${(seed >>> 8) & 255},${(seed >>> 16) & 255})`;
          textureCtx.fillRect(x, y, 8, 8);
        }
      }
      let frame = 0;
      let animation = 0;
      const draw = () => {
        const x = (frame++ * 11) % 2560;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(texture, x - 2560, 0, 2560, 1440);
        ctx.drawImage(texture, x, 0, 2560, 1440);
        animation = requestAnimationFrame(draw);
      };
      draw();

      const options = {
        ...presets.getScreenShareCaptureOptions("source", 60),
        // Fix the input size for both arms independently of capture defaults.
        resolution: { width: 2560, height: 1440, frameRate: 60 },
        preferCurrentTab: true,
        audio: false,
      };
      const tracks = await sdk.createLocalScreenTracks(options);
      const video = tracks.find((track) => track.kind === sdk.Track.Kind.Video)!;
      const raw = video.mediaStreamTrack;
      const initialHint = raw.contentHint;
      const initialCapture = raw.getSettings();
      if (applyFix) presets.applyScreenShareContentHint(raw, options, "vp8");
      const senderPc = new RTCPeerConnection({ iceServers: [] });
      const receiverPc = new RTCPeerConnection({ iceServers: [] });
      const transceiver = senderPc.addTransceiver(raw, {
        direction: "sendonly",
        sendEncodings: [{ maxBitrate: 15_000_000, maxFramerate: 60 }],
      });
      transceiver.setCodecPreferences(
        RTCRtpSender.getCapabilities("video")!.codecs.filter(
          (codec) => codec.mimeType.toLowerCase() === "video/vp8",
        ),
      );
      const gather = async (pc: RTCPeerConnection) => {
        if (pc.iceGatheringState === "complete") return;
        await new Promise<void>((resolve) => {
          const changed = () => {
            if (pc.iceGatheringState !== "complete") return;
            pc.removeEventListener("icegatheringstatechange", changed);
            resolve();
          };
          pc.addEventListener("icegatheringstatechange", changed);
          changed();
        });
      };
      const setBudget = async (maxBitrate: number) => {
        const params = transceiver.sender.getParameters();
        params.degradationPreference = "maintain-framerate";
        params.encodings[0]!.maxBitrate = maxBitrate;
        params.encodings[0]!.maxFramerate = 60;
        await transceiver.sender.setParameters(params);
      };
      interface Sample {
        phase: string;
        width?: number;
        height?: number;
        fps?: number;
        framesEncoded?: number;
        captureFps?: number;
        limitation?: string;
        bytesSent?: number;
        targetBitrate?: number;
        encoder?: string;
        codec?: string;
        receivedWidth?: number;
        receivedHeight?: number;
        framesSent?: number;
        framesDecoded?: number;
        maxBitrate: number;
        availableOutgoingBitrate?: number;
        sourceWidth?: number;
        sourceHeight?: number;
        trackState: MediaStreamTrackState;
      }
      const samples: Sample[] = [];
      // The fixed arm runs the production resolution-recovery watcher on this
      // sender, the way a published share does, and records each nudge.
      const nudges: Array<{ phase: string; preference: RTCDegradationPreference }> = [];
      let phaseNow = "warmup";
      const stopRecovery = applyFix
        ? recovery.watchShareResolutionRecovery(
            {
              sender: transceiver.sender,
              mediaStreamTrack: raw,
              setDegradationPreference: async (preference) => {
                nudges.push({ phase: phaseNow, preference });
                const params = transceiver.sender.getParameters();
                params.degradationPreference = preference;
                await transceiver.sender.setParameters(params);
              },
            },
            "maintain-framerate",
          )
        : () => {};
      let previousFrames: number | undefined;
      let previousTimestamp: number | undefined;
      try {
        const offer = await senderPc.createOffer();
        // Give both arms identical startup headroom before the deliberate
        // budget reduction; otherwise startup probing can downscale first.
        offer.sdp = offer.sdp!.replace(
          /(a=rtpmap:(\d+) VP8\/90000\r\n)/,
          "$1a=fmtp:$2 x-google-start-bitrate=15000\r\n",
        );
        await senderPc.setLocalDescription(offer);
        await gather(senderPc);
        await receiverPc.setRemoteDescription(senderPc.localDescription!);
        await receiverPc.setLocalDescription(await receiverPc.createAnswer());
        await gather(receiverPc);
        await senderPc.setRemoteDescription(receiverPc.localDescription!);
        // Recovery keeps the same capture and connections and gives WebRTC's
        // upscale hysteresis time to act once the bandwidth estimate rises.
        const phases: Array<[string, number, number]> = [
          ["warmup", 15_000_000, 6],
          ["pressure", 300_000, 30],
        ];
        if (applyFix) phases.push(["recovery", 15_000_000, 90]);
        for (const [phase, budget, seconds] of phases) {
          phaseNow = phase;
          await setBudget(budget);
          for (let second = 0; second < seconds; second++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const stats = await senderPc.getStats();
            const sample: Sample = { phase, maxBitrate: budget, trackState: raw.readyState };
            stats.forEach((row) => {
              if (row.type === "media-source" && row.kind === "video") {
                sample.captureFps = row.framesPerSecond;
                sample.sourceWidth = row.width;
                sample.sourceHeight = row.height;
              }
              if (row.type === "candidate-pair" && row.nominated && row.state === "succeeded")
                sample.availableOutgoingBitrate = row.availableOutgoingBitrate;
              if (row.type !== "outbound-rtp" || row.kind !== "video") return;
              sample.width = row.frameWidth;
              sample.height = row.frameHeight;
              sample.fps = row.framesPerSecond;
              sample.framesEncoded = row.framesEncoded;
              // Browsers omit framesPerSecond when no frame was encoded in
              // the last interval. Counter deltas distinguish that from
              // missing telemetry without inventing a fallback frame rate.
              if (previousFrames !== undefined && previousTimestamp !== undefined) {
                sample.fps =
                  ((row.framesEncoded - previousFrames) * 1000) /
                  (row.timestamp - previousTimestamp);
              }
              previousFrames = row.framesEncoded;
              previousTimestamp = row.timestamp;
              sample.framesSent = row.framesSent;
              sample.limitation = row.qualityLimitationReason;
              sample.bytesSent = row.bytesSent;
              sample.targetBitrate = row.targetBitrate;
              sample.encoder = row.encoderImplementation;
              sample.codec = stats.get(row.codecId)?.mimeType;
            });
            (await receiverPc.getStats()).forEach((row) => {
              if (row.type !== "inbound-rtp" || row.kind !== "video") return;
              sample.receivedWidth = row.frameWidth;
              sample.receivedHeight = row.frameHeight;
              sample.framesDecoded = row.framesDecoded;
            });
            samples.push(sample);
          }
        }
        return {
          fixed: applyFix,
          initialHint,
          initialCapture,
          hint: raw.contentHint,
          capture: raw.getSettings(),
          samples,
          nudges,
        };
      } finally {
        stopRecovery();
        senderPc.close();
        receiverPc.close();
        tracks.forEach((track) => track.stop());
        cancelAnimationFrame(animation);
      }
    }, fixed);
    results.push(result);
    const name = fixed ? "vp8-fixed.json" : "vp8-before.json";
    const path = testInfo.outputPath(name);
    await writeFile(path, JSON.stringify(result, null, 2));
    await testInfo.attach(name, {
      path,
      contentType: "application/json",
    });
    console.log(name, JSON.stringify(result.samples.slice(-10)));
  }

  const before = results[0]!;
  const after = results[1]!;
  expect(before.initialHint).toBe("");
  expect(before.hint).toBe("");
  expect(after.hint).toBe("motion");
  expect(after.initialCapture.width).toBe(2560);
  expect(after.initialCapture.height).toBe(1440);
  const warm = after.samples.filter((sample) => sample.phase === "warmup");
  const warmWidth = Math.max(...warm.map((sample) => sample.width ?? 0));
  const stableWarmWidth = warm.at(-1)!.width!;
  const pressure = after.samples.filter((sample) => sample.phase === "pressure").slice(-10);
  expect(pressure.every((sample) => sample.codec === "video/VP8")).toBe(true);
  expect(pressure.every((sample) => (sample.width ?? 2560) < warmWidth)).toBe(true);
  expect(pressure.every((sample) => (sample.receivedWidth ?? 2560) < warmWidth)).toBe(true);
  expect(pressure.filter((sample) => (sample.fps ?? 0) >= 45).length).toBeGreaterThanOrEqual(8);
  const baseline = before.samples.filter((sample) => sample.phase === "pressure").slice(-10);
  expect(baseline.every((sample) => sample.width === 2560 && sample.height === 1440)).toBe(true);
  expect(baseline.every((sample) => (sample.fps ?? 60) < 20)).toBe(true);

  // Recovery: the bandwidth estimate itself must rise (a raised maxBitrate
  // alone proves nothing), then the same share must climb back to at least
  // the stable warmup size without collapsing frame rate.
  // The watcher may only step in once the bitrate has come back.
  expect(after.nudges.length).toBeGreaterThan(0);
  expect(after.nudges.every((nudge) => nudge.phase === "recovery")).toBe(true);
  const recovery = after.samples.filter((sample) => sample.phase === "recovery");
  const settled = recovery.slice(-10);
  const pressureWidth = pressure.at(-1)!.width!;
  expect(recovery.every((sample) => sample.trackState === "live")).toBe(true);
  expect(
    after.samples.every(
      (sample, i) => i === 0 || sample.framesEncoded! > after.samples[i - 1]!.framesEncoded!,
    ),
  ).toBe(true);
  expect(
    settled.every(
      (sample) => (sample.availableOutgoingBitrate ?? sample.targetBitrate ?? 0) >= 1_000_000,
    ),
  ).toBe(true);
  expect(settled.every((sample) => sample.width! >= stableWarmWidth)).toBe(true);
  expect(settled.every((sample) => sample.width! > pressureWidth)).toBe(true);
  expect(settled.every((sample) => (sample.receivedWidth ?? 0) >= stableWarmWidth)).toBe(true);
  // Known: at 2560x1440 software VP8, WebRTC's own 1080p/1440p probing dips
  // for 2-4 s to 33-44 fps every ~10 s, so this bar missed in 3 of 10 runs
  // on a quiet 2026-11 Windows desktop (median stayed 59.9 fps in all 10).
  expect(settled.filter((sample) => (sample.fps ?? 0) >= 45).length).toBeGreaterThanOrEqual(8);
  expect(
    recovery.filter((sample) => (sample.fps ?? 0) >= 45).length / recovery.length,
  ).toBeGreaterThanOrEqual(0.8);
});
