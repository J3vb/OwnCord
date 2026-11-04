import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachRecorder } from "@lib/diagnostics/eventSink";
import {
  cameraSampleFromStats,
  createCameraStallWatchdog,
  type CameraLayerSample,
} from "./cameraStallWatchdog";

type Seen = { code: string; fields: Readonly<Record<string, unknown>> };

const POLL_MS = 2000;

function layer(rid: string, framesSent: number, active = true): CameraLayerSample {
  return {
    rid,
    active,
    framesSent,
    width: rid === "f" ? 1280 : 640,
    height: rid === "f" ? 720 : 360,
    fps: 30,
    encoder: "ExternalEncoder (MediaFoundationVideoEncoder)",
    hardwareEncoder: true,
    qualityLimitation: "none",
  };
}

describe("camera stall watchdog", () => {
  let seen: Seen[];
  let detach: () => void;
  beforeEach(() => {
    seen = [];
    detach = attachRecorder((code, fields) => seen.push({ code, fields }));
  });
  afterEach(() => detach());

  it("records a stall when frames stop for 3 s and the resume with the gap", () => {
    const dog = createCameraStallWatchdog();
    // Frames flow, then the camera delivers nothing for about 3 s, then flows again.
    const frames = [0, 60, 120, 120, 120, 180];
    frames.forEach((n, i) => dog.sample(i * POLL_MS, { live: true, layers: [layer("f", n)] }));

    expect(seen.map((e) => e.code)).toEqual(["camera.stalled", "camera.resumed"]);
    expect(seen[0]!.fields).toMatchObject({
      frames_sent: 120,
      encoder: "ExternalEncoder_MediaFoundationVideoEncoder_",
      hardware_encoder: true,
      quality_limitation: "none",
      width: 1280,
      height: 720,
      active_layers: 1,
    });
    // Last new frame seen at the 4 s poll, new frames again at the 10 s poll.
    expect(seen[1]!.fields).toMatchObject({ gap_ms: 6000 });
  });

  it("ignores a single slow poll below the threshold", () => {
    const dog = createCameraStallWatchdog();
    dog.sample(0, { live: true, layers: [layer("f", 10)] });
    dog.sample(1500, { live: true, layers: [layer("f", 10)] });
    dog.sample(3000, { live: true, layers: [layer("f", 50)] });
    expect(seen).toEqual([]);
  });

  it("does not count layers the server paused because nobody watches", () => {
    const dog = createCameraStallWatchdog();
    for (let i = 0; i < 5; i++) {
      dog.sample(i * POLL_MS, {
        live: true,
        layers: [layer("f", 100, false), layer("q", 100, false)],
      });
    }
    expect(seen).toEqual([]);
  });

  it("treats one still-moving active layer as progress", () => {
    const dog = createCameraStallWatchdog();
    for (let i = 0; i < 5; i++) {
      dog.sample(i * POLL_MS, { live: true, layers: [layer("f", 100), layer("q", 100 + i)] });
    }
    expect(seen).toEqual([]);
  });

  it("forgets a stall when the user turns the camera off", () => {
    const dog = createCameraStallWatchdog();
    dog.sample(0, { live: true, layers: [layer("f", 10)] });
    dog.sample(POLL_MS, { live: true, layers: [layer("f", 10)] });
    dog.sample(2 * POLL_MS, { live: true, layers: [layer("f", 10)] });
    dog.sample(3 * POLL_MS, { live: false, layers: [layer("f", 10)] });
    dog.sample(4 * POLL_MS, { live: true, layers: [layer("f", 40)] });
    expect(seen.map((e) => e.code)).toEqual(["camera.stalled"]);
  });

  it("records the active layer count when it moves, not on the first sample", () => {
    const dog = createCameraStallWatchdog();
    const at = (i: number, layers: CameraLayerSample[], live = true): void =>
      dog.sample(i * POLL_MS, { live, layers });
    at(0, [layer("f", 10), layer("q", 10)]);
    at(1, [layer("f", 70), layer("q", 70)]);
    at(2, [layer("f", 70, false), layer("q", 130)]);
    at(3, [layer("f", 70, false), layer("q", 130, false)]);
    at(4, [layer("f", 70, false), layer("q", 130, false)], false);
    at(5, [layer("f", 70), layer("q", 190)]);
    const changes = seen.filter((e) => e.code === "track.layers_changed").map((e) => e.fields);
    expect(changes).toEqual([
      { source: "camera", active_layers: 1 },
      { source: "camera", active_layers: 0 },
    ]);
  });

  it("reads layers from outbound video entries only", () => {
    const sample = cameraSampleFromStats(true, [
      {
        type: "outbound-rtp",
        kind: "video",
        rid: "f",
        active: true,
        framesSent: 9,
        frameWidth: 1280,
      },
      { type: "outbound-rtp", kind: "audio", packetsSent: 4 },
      { type: "inbound-rtp", kind: "video", framesDecoded: 3 },
      { type: "outbound-rtp", kind: "video", rid: "q", active: false, framesSent: 2 },
    ]);
    expect(sample.layers.map((l) => [l.rid, l.active, l.framesSent])).toEqual([
      ["f", true, 9],
      ["q", false, 2],
    ]);
  });
});
