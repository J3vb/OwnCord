#!/usr/bin/env node
// Spike only, never merged. Attaches to a running OwnCord desktop client over
// the WebView2 DevTools port and measures what the webview can do for our own
// Windows share picker: Chromium source ids, track generators, encoder choice
// for CPU frames, and H.265. Needs Node 22+ (global WebSocket) and Windows.
//
// Start OwnCord with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS containing
// --remote-debugging-port=9222 first (see the run sheet), then:
//   node w0-webview-probe.mjs --label baseline --hwnd 0x1234 --out results-baseline.json

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--"))
      acc.push([a.slice(2), all[i + 1]?.startsWith("--") ? "1" : (all[i + 1] ?? "1")]);
    return acc;
  }, []),
);
const port = Number(args.port ?? 9222);
const label = args.label ?? "run";
const hwnd = args.hwnd ? Number(args.hwnd) : 0;
const encodeSecs = Number(args.secs ?? 20);
const outFile = args.out ?? `w0-results-${label}.json`;
const skipGdm = args["skip-gdm"] === "1";
// WebView2 hides encoderImplementation unless the page holds a capture
// permission, so the encoder runs can keep a microphone stream open.
const holdMic = args["hold-mic"] === "1";
const onlyEncode = args["only-encode"] === "1";

if (typeof WebSocket !== "function") {
  console.error("Node 22 or newer is needed (global WebSocket).");
  process.exit(2);
}

async function pickTarget() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pages = list.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  const main =
    pages.find((t) => /tauri|localhost/.test(t.url) && !/popout|share-bar/i.test(t.url)) ??
    pages[0];
  if (!main) throw new Error(`no page target on port ${port}: ${JSON.stringify(list)}`);
  return { main, all: list.map((t) => ({ type: t.type, url: t.url, title: t.title })) };
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  };
  const ready = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP socket failed"));
  });
  return {
    ready,
    send(method, params) {
      const n = ++id;
      ws.send(JSON.stringify({ id: n, method, params }));
      return new Promise((res) => waiting.set(n, res));
    },
    close: () => ws.close(),
  };
}

// CPU of OwnCord's own processes (owncord.exe and the msedgewebview2 processes
// that use its profile) plus dwm, sampled once a second from Get-Process, which
// is not localized like performance counters are.
function startCpuSampler() {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$own = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -like 'owncord*') -or ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like '*com.owncord.client*')
} | Select-Object -ExpandProperty ProcessId
$dwm = (Get-Process dwm).Id
while ($true) {
  $p = Get-Process -Id (@($own) + @($dwm))
  $o = @{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); own = 0.0; dwm = 0.0; n = 0 }
  foreach ($x in $p) { if ($x.Id -eq $dwm) { $o.dwm += $x.CPU } else { $o.own += $x.CPU; $o.n++ } }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  Start-Sleep -Milliseconds 1000
}`;
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", ps], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.on("error", () => {});
  const samples = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("{")) samples.push(JSON.parse(line));
    }
  });
  const cores = os.cpus().length;
  return {
    stop: () => child.kill(),
    // Average % of the whole CPU (all logical cores) between two wall times.
    between(t0, t1) {
      const s = samples.filter((x) => x.t >= t0 && x.t <= t1);
      if (s.length < 2) return null;
      const a = s[0];
      const b = s[s.length - 1];
      const sec = (b.t - a.t) / 1000;
      const pct = (d) => Math.round((d / sec / cores) * 100 * 10) / 10;
      return {
        ownPctOfAllCores: pct(b.own - a.own),
        dwmPctOfAllCores: pct(b.dwm - a.dwm),
        processes: b.n,
        seconds: sec,
        cores,
      };
    },
  };
}

// Runs inside the OwnCord page. Every probe catches its own error.
const PAGE_HELPERS = String.raw`(() => {
window.__w0 = window.__w0 || {};
const W0 = window.__w0;
W0.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
W0.guard = async (fn, ms) => {
  try {
    return await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + ms + " ms")), ms))]);
  } catch (e) {
    return { error: String(e && e.name) + ": " + String(e && e.message) };
  }
};
W0.describe = (s) => s.getTracks().map((t) => ({ kind: t.kind, label: t.label, settings: t.getSettings() }));
W0.features = async () => {
  const f = {
    userAgent: navigator.userAgent,
    url: location.href,
    MediaStreamTrackGenerator: typeof MediaStreamTrackGenerator,
    VideoTrackGenerator: typeof VideoTrackGenerator,
    MediaStreamTrackProcessor: typeof MediaStreamTrackProcessor,
    VideoFrame: typeof VideoFrame,
    VideoEncoder: typeof VideoEncoder,
    webviewHostObject: !!(window.chrome && window.chrome.webview),
    sharedBufferListener: !!(window.chrome && window.chrome.webview && window.chrome.webview.addEventListener),
    crossOriginIsolated: self.crossOriginIsolated,
    SharedArrayBuffer: typeof SharedArrayBuffer,
  };
  f.worker = await W0.guard(() => new Promise((res, rej) => {
    const src = "postMessage({MediaStreamTrackGenerator: typeof MediaStreamTrackGenerator, VideoTrackGenerator: typeof VideoTrackGenerator, VideoFrame: typeof VideoFrame})";
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    w.onmessage = (e) => { res(e.data); w.terminate(); };
    w.onerror = (e) => rej(new Error(e.message || "worker error (CSP?)"));
  }), 5000);
  const caps = (dir) => (window[dir] && window[dir].getCapabilities ? window[dir].getCapabilities("video").codecs.map((c) => c.mimeType + (c.sdpFmtpLine ? " " + c.sdpFmtpLine : "")) : null);
  f.senderCodecs = caps("RTCRtpSender");
  f.receiverCodecs = caps("RTCRtpReceiver");
  const vec = async (codec, w, h) => W0.guard(async () => {
    if (typeof VideoEncoder === "undefined") return "no VideoEncoder";
    const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, framerate: 60, bitrate: 12e6, hardwareAcceleration: "prefer-hardware" });
    return r.supported;
  }, 5000);
  f.webcodecsHardware = {
    "h264 1920x1080": await vec("avc1.640033", 1920, 1080),
    "h264 3840x1080": await vec("avc1.640033", 3840, 1080),
    "h264 5120x1440": await vec("avc1.640034", 5120, 1440),
    "hevc 1920x1080": await vec("hvc1.1.6.L153.B0", 1920, 1080),
    "hevc 5120x1440": await vec("hvc1.1.6.L186.B0", 5120, 1440),
  };
  return f;
};
W0.sourceIds = async (hwnd) => {
  const out = {};
  const gum = (id, audio) => W0.guard(async () => {
    const c = { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: id } };
    const s = await navigator.mediaDevices.getUserMedia({ audio: audio ? c : false, video: { mandatory: { ...c.mandatory, maxWidth: 1920, maxHeight: 1080 } } });
    const d = W0.describe(s);
    s.getTracks().forEach((t) => t.stop());
    return { ok: true, tracks: d };
  }, 15000);
  if (hwnd) {
    out["window:hwnd:0"] = await gum("window:" + hwnd + ":0", false);
    out["window:hwnd:0 +audio"] = await gum("window:" + hwnd + ":0", true);
  }
  out["screen:0:0"] = await gum("screen:0:0", false);
  out["screen:1:0"] = await gum("screen:1:0", false);
  out["screen:-1:0"] = await gum("screen:-1:0", false);
  out["chromeMediaSource screen (no id)"] = await W0.guard(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: "screen" } } });
    const d = W0.describe(s);
    s.getTracks().forEach((t) => t.stop());
    return { ok: true, tracks: d };
  }, 15000);
  return out;
};
W0.gdm = async () => W0.guard(async () => {
  const t0 = performance.now();
  const s = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "monitor" }, audio: false, selfBrowserSurface: "exclude", monitorTypeSurfaces: "include" });
  const d = W0.describe(s);
  s.getTracks().forEach((t) => t.stop());
  return { ok: true, msUntilResolved: Math.round(performance.now() - t0), tracks: d };
}, 25000);
W0.canvasTrack = (w, h, fps) => {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  let n = 0;
  const timer = setInterval(() => {
    n++;
    g.fillStyle = "hsl(" + ((n * 7) % 360) + ",70%,40%)";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#fff";
    g.font = "120px sans-serif";
    g.fillText(String(n), 40 + ((n * 23) % (w - 400)), 200 + ((n * 11) % (h - 300)));
  }, 1000 / fps);
  const track = c.captureStream(fps).getVideoTracks()[0];
  return { track, stop: () => { clearInterval(timer); track.stop(); }, stats: () => ({}) };
};
// CPU-filled NV12 frames, the way path B would hand frames to the page: a
// buffer copy into a new VideoFrame, written into a generator.
W0.generatorTrack = (w, h, fps) => {
  if (typeof MediaStreamTrackGenerator === "undefined") throw new Error("MediaStreamTrackGenerator missing");
  const gen = new MediaStreamTrackGenerator({ kind: "video" });
  const writer = gen.writable.getWriter();
  const size = (w * h * 3) / 2;
  const buf = new Uint8Array(size);
  buf.fill(128);
  const st = { written: 0, droppedBackpressure: 0, frameCtorMsTotal: 0, late: 0 };
  let running = true;
  const period = 1000 / fps;
  const t0 = performance.now();
  (async () => {
    let next = t0;
    while (running) {
      const band = (st.written * 8) % Math.floor(h / 2);
      buf.fill(st.written & 255, band * w, Math.min(h, band + h / 8) * w);
      const c0 = performance.now();
      const frame = new VideoFrame(buf, {
        format: "NV12", codedWidth: w, codedHeight: h, timestamp: Math.round((c0 - t0) * 1000),
        colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
      });
      st.frameCtorMsTotal += performance.now() - c0;
      if (writer.desiredSize !== null && writer.desiredSize <= 0) {
        st.droppedBackpressure++;
        frame.close();
      } else {
        await writer.write(frame);
        frame.close();
        st.written++;
      }
      next += period;
      const wait = next - performance.now();
      if (wait > 0) await W0.sleep(wait); else { st.late++; next = performance.now(); }
    }
  })();
  return {
    track: gen,
    stop: () => { running = false; writer.close().catch(() => {}); gen.stop(); },
    stats: () => {
      const secs = (performance.now() - t0) / 1000;
      return { ...st, writtenFps: Math.round((st.written / secs) * 10) / 10, frameCtorMsAvg: Math.round((st.frameCtorMsTotal / Math.max(1, st.written + st.droppedBackpressure)) * 100) / 100 };
    },
  };
};
// Sends one track through a local peer-connection pair and reads what the
// encoder did. No server, nothing leaves the PC.
W0.encode = async (kind, w, h, fps, mime, secs) => W0.guard(async () => {
  const src = kind === "generator" ? W0.generatorTrack(w, h, fps) : W0.canvasTrack(w, h, fps);
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  try {
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    let gotTrack;
    const remote = new Promise((r) => { gotTrack = r; });
    b.ontrack = (e) => {
      const v = document.createElement("video");
      v.muted = true; v.srcObject = new MediaStream([e.track]); v.play().catch(() => {});
      gotTrack(v);
    };
    const tr = a.addTransceiver(src.track, { direction: "sendonly" });
    const want = RTCRtpSender.getCapabilities("video").codecs.filter((c) => c.mimeType.toLowerCase() === mime.toLowerCase());
    if (!want.length) return { error: "sender has no " + mime };
    // OwnCord shares H.264 as High or Main, never Constrained Baseline.
    const rank = (c) => (/profile-level-id=64/.test(c.sdpFmtpLine || "") ? 0 : /profile-level-id=4d/.test(c.sdpFmtpLine || "") ? 1 : 2);
    want.sort((x, y) => rank(x) - rank(y));
    tr.setCodecPreferences(want);
    if ("contentHint" in src.track) src.track.contentHint = "motion";
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription();
    // Start and hold the bandwidth estimate high, so the loopback measures the
    // encoder at full size instead of the first seconds of bandwidth ramp-up.
    const sdp = b.localDescription.sdp.replace(/^(a=fmtp:\d+ (?!apt=).*)$/gm, "$1;x-google-min-bitrate=8000;x-google-start-bitrate=12000;x-google-max-bitrate=20000");
    await a.setRemoteDescription({ type: "answer", sdp });
    const p = tr.sender.getParameters();
    if (p.encodings && p.encodings[0]) {
      p.encodings[0].maxBitrate = 20e6;
      p.encodings[0].maxFramerate = fps;
      p.degradationPreference = "maintain-framerate";
      await tr.sender.setParameters(p).catch(() => {});
    }
    await remote;
    const read = async () => {
      const out = {};
      const sa = await a.getStats();
      const codecs = {};
      sa.forEach((s) => { if (s.type === "codec") codecs[s.id] = s.mimeType + (s.sdpFmtpLine ? " " + s.sdpFmtpLine : ""); });
      sa.forEach((s) => {
        if (s.type === "outbound-rtp" && s.kind === "video") {
          out.sender = { codec: codecs[s.codecId], encoderImplementation: s.encoderImplementation, powerEfficientEncoder: s.powerEfficientEncoder, frameWidth: s.frameWidth, frameHeight: s.frameHeight, framesEncoded: s.framesEncoded, framesSent: s.framesSent, totalEncodeTime: s.totalEncodeTime, qualityLimitationReason: s.qualityLimitationReason, bytesSent: s.bytesSent };
        }
        if (s.type === "media-source" && s.kind === "video") out.source = { width: s.width, height: s.height, framesPerSecond: s.framesPerSecond, frames: s.frames };
      });
      const sb = await b.getStats();
      sb.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "video") out.receiver = { decoderImplementation: s.decoderImplementation, framesDecoded: s.framesDecoded, frameWidth: s.frameWidth, frameHeight: s.frameHeight };
      });
      return out;
    };
    await W0.sleep(5000);
    const first = await read();
    const t1 = performance.now();
    await W0.sleep(secs * 1000);
    const last = await read();
    const dt = (performance.now() - t1) / 1000;
    const rate = (k) => (last.sender && first.sender ? Math.round(((last.sender[k] - first.sender[k]) / dt) * 10) / 10 : null);
    return {
      kind, size: w + "x" + h, fps, mime,
      encodedFps: rate("framesEncoded"),
      sentFps: rate("framesSent"),
      mbps: last.sender && first.sender ? Math.round(((last.sender.bytesSent - first.sender.bytesSent) * 8) / dt / 1e5) / 10 : null,
      encodeMsPerFrame: last.sender && first.sender && last.sender.framesEncoded > first.sender.framesEncoded
        ? Math.round(((last.sender.totalEncodeTime - first.sender.totalEncodeTime) / (last.sender.framesEncoded - first.sender.framesEncoded)) * 10000) / 10 : null,
      last, producer: src.stats(),
    };
  } finally {
    src.stop();
    a.close();
    b.close();
  }
}, (secs + 30) * 1000);
})();
"ready";
`;

async function main() {
  const { main: target, all } = await pickTarget();
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  const evalPage = async (expr, ms = 120000) => {
    const r = await c.send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      timeout: ms,
    });
    if (r.error) return { cdpError: r.error };
    if (r.result.exceptionDetails)
      return {
        exception:
          r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text,
      };
    return r.result.result.value;
  };
  const inject = await evalPage(PAGE_HELPERS);
  if (inject !== "ready") throw new Error(`helper injection failed: ${JSON.stringify(inject)}`);

  const cpu = startCpuSampler();
  await new Promise((r) => setTimeout(r, 2500));
  const results = {
    label,
    at: new Date().toISOString(),
    node: process.version,
    browser: version,
    targets: all,
    hwnd,
    phases: [],
  };
  const phase = async (name, expr, ms) => {
    console.log(`[${new Date().toISOString()}] ${name} ...`);
    const t0 = Date.now();
    const value = await evalPage(expr, ms);
    const t1 = Date.now();
    const entry = { name, ms: t1 - t0, cpu: cpu.between(t0 + 4000, t1), value };
    results.phases.push(entry);
    console.log(JSON.stringify(entry).slice(0, 600));
    writeFileSync(outFile, JSON.stringify(results, null, 2));
    return entry;
  };

  await phase("idle 10 s (CPU baseline)", "window.__w0.sleep(10000).then(() => 'idle')", 20000);
  await phase("features", "window.__w0.features()", 30000);
  if (!onlyEncode) await phase("source ids (probe 1)", `window.__w0.sourceIds(${hwnd})`, 120000);
  if (holdMic) {
    await phase(
      "hold microphone",
      "navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { window.__w0.mic = s; return window.__w0.describe(s); }).catch((e) => ({ error: String(e) }))",
      20000,
    );
  }
  if (!skipGdm && !onlyEncode) await phase("getDisplayMedia monitor", "window.__w0.gdm()", 40000);
  const allRuns = [
    ["canvas", 1920, 1080, 60, "video/H264"],
    ["generator", 1920, 1080, 60, "video/H264"],
    ["generator", 2560, 1440, 60, "video/H264"],
    ["generator", 3840, 1080, 60, "video/H264"],
    ["generator", 5120, 1440, 60, "video/H264"],
    ["generator", 2560, 1440, 60, "video/H265"],
    ["generator", 5120, 1440, 60, "video/H265"],
  ];
  const runs = onlyEncode ? allRuns.filter((r) => r[4] === "video/H264") : allRuns;
  for (const [kind, w, h, fps, mime] of runs) {
    await phase(
      `encode ${kind} ${w}x${h}@${fps} ${mime}`,
      `window.__w0.encode(${JSON.stringify(kind)}, ${w}, ${h}, ${fps}, ${JSON.stringify(mime)}, ${encodeSecs})`,
      (encodeSecs + 60) * 1000,
    );
  }
  cpu.stop();
  c.close();
  writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`\nWrote ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
