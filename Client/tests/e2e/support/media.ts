import { expect, type Page } from "@playwright/test";

type MediaProbe = {
  peers: RTCPeerConnection[];
  signaling: WebSocket[];
  tracks: MediaStreamTrack[];
  denyMic: boolean;
  poorQuality: boolean;
  keyFault: "none" | "missing" | "wrong";
  keyMessages: number;
  decodeTransforms: number;
  plaintextEnables: number;
  read(): Promise<{
    audioEnergy: number;
    audioSamples: number;
    videoFrames: number;
    receivedBytes: number;
    sentBytes: number;
    liveCapture: number;
    senders: number;
  }>;
  restoreKeys(): void;
};
declare global {
  interface Window {
    __ocMedia: MediaProbe;
  }
}

/** Observe real peer connections; inject faults at browser API boundaries,
 * never by writing application stores, badges, toasts or CSS. */
export async function installMediaProbe(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        // OwnCord's application socket lives in the Node transport adapter;
        // these are the real LiveKit browser signaling connections.
        probe.signaling.push(this);
      }
    };
    const originalStats = RTCPeerConnection.prototype.getStats;
    const originalGetMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const originalPost = Worker.prototype.postMessage;
    const keys = new Map<Worker, Map<string, unknown>>();
    const wrongKey = crypto.subtle.importKey(
      "raw",
      crypto.getRandomValues(new Uint8Array(32)),
      "HKDF",
      false,
      ["deriveBits", "deriveKey"],
    );
    const probe: MediaProbe = {
      peers: [],
      signaling: [],
      tracks: [],
      denyMic: false,
      poorQuality: false,
      keyFault: "none",
      keyMessages: 0,
      decodeTransforms: 0,
      plaintextEnables: 0,
      async read() {
        let audioEnergy = 0,
          audioSamples = 0,
          videoFrames = 0,
          receivedBytes = 0,
          sentBytes = 0,
          senders = 0;
        for (const peer of probe.peers) {
          if (peer.connectionState === "closed") continue;
          senders += peer
            .getSenders()
            .filter((sender) => sender.track?.readyState === "live").length;
          const report = await originalStats.call(peer);
          report.forEach((entry) => {
            if (entry.type === "outbound-rtp") sentBytes += entry.bytesSent ?? 0;
            if (entry.type !== "inbound-rtp") return;
            receivedBytes += entry.bytesReceived ?? 0;
            if (entry.kind === "audio") {
              audioEnergy += entry.totalAudioEnergy ?? 0;
              audioSamples += Math.max(
                0,
                (entry.totalSamplesReceived ?? 0) - (entry.concealedSamples ?? 0),
              );
            }
            if (entry.kind === "video") videoFrames += entry.framesDecoded ?? 0;
          });
        }
        return {
          audioEnergy,
          audioSamples,
          videoFrames,
          receivedBytes,
          sentBytes,
          senders,
          liveCapture: probe.tracks.filter((track) => track.readyState === "live").length,
        };
      },
      restoreKeys() {
        probe.keyFault = "none";
        for (const [worker, messages] of keys)
          for (const message of messages.values()) originalPost.call(worker, message);
      },
    };
    window.__ocMedia = probe;
    const OriginalPeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends OriginalPeer {
      constructor(config?: RTCConfiguration) {
        super(config);
        probe.peers.push(this);
      }
    };
    RTCPeerConnection.prototype.getStats = async function (selector?: MediaStreamTrack | null) {
      const report = await originalStats.call(this, selector);
      if (probe.poorQuality)
        report.forEach((entry) => {
          if (entry.type === "candidate-pair") entry.currentRoundTripTime = 0.8;
        });
      return report;
    };
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints?.audio && probe.denyMic)
        throw new DOMException("Microphone permission denied by test", "NotAllowedError");
      const stream = await originalGetMedia(constraints);
      probe.tracks.push(...stream.getTracks());
      return stream;
    };
    Worker.prototype.postMessage = function (message: any, options?: any) {
      if (message?.kind === "decode") probe.decodeTransforms++;
      if (message?.kind === "enable" && message.data?.enabled === false) probe.plaintextEnables++;
      if (message?.kind === "setKey") {
        probe.keyMessages++;
        const messages = keys.get(this) ?? new Map<string, unknown>();
        messages.set(`${message.data.participantIdentity}:${message.data.keyIndex}`, message);
        keys.set(this, messages);
        if (probe.keyFault === "missing") return;
        if (probe.keyFault === "wrong") {
          void wrongKey.then((key) =>
            originalPost.call(this, { ...message, data: { ...message.data, key } }),
          );
          return;
        }
      }
      originalPost.call(this, message, options);
    };
  });
}

export const mediaStats = (page: Page) => page.evaluate(() => window.__ocMedia.read());

export async function expectDecodedMedia(page: Page, video = false) {
  const initial = await mediaStats(page);
  await expect
    .poll(
      async () => {
        const now = await mediaStats(page);
        return (
          now.audioEnergy > initial.audioEnergy &&
          now.audioSamples > initial.audioSamples &&
          (!video || now.videoFrames > initial.videoFrames)
        );
      },
      {
        timeout: 30_000,
        message:
          "Remote media must decode and advance (a connected badge or RTP bytes alone is insufficient)",
      },
    )
    .toBe(true);
}

export async function joinVoice(page: Page, name = "voice-one") {
  await page.locator(".channel-item.voice", { hasText: name }).click();
  await expect(page.locator(".voice-widget.visible .vw-channel")).toHaveText(name);
  await expect(page.locator(".voice-widget.visible")).toContainText("Voice Connected", {
    timeout: 30_000,
  });
}
