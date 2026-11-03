// Pauses the user's camera while the Android app is in the background and
// turns it back on when they return, so others see the avatar instead of a
// frozen picture. Only a camera this module switched off is switched on again,
// and only in the same call.

import { createLogger } from "../../lib/logger";
import { voiceStore } from "../../stores/voice.store";

const log = createLogger("background-camera");

interface Paused {
  readonly channelId: number;
  readonly joinedAt: number | null;
}

const hidden = (): boolean => document.visibilityState === "hidden";

/** Follow the page's visibility until `signal` aborts. */
export function startBackgroundCamera(signal: AbortSignal): void {
  if (signal.aborted) return;
  let paused: Paused | null = null;
  let chain: Promise<void> = Promise.resolve();

  const pause = async (): Promise<void> => {
    if (!hidden()) return;
    const state = voiceStore.getState();
    if (
      state.currentChannelId === null ||
      state.voiceStatus !== "connected" ||
      !state.localCamera
    ) {
      return;
    }
    paused = { channelId: state.currentChannelId, joinedAt: state.joinedAt };
    const { disableCamera } = await import("../../lib/voice/livekitSession");
    await disableCamera();
  };

  const resume = async (): Promise<void> => {
    if (hidden() || paused === null) return;
    const state = voiceStore.getState();
    // A reconnecting call keeps the pending resume until it is connected again.
    if (state.voiceStatus !== "connected") return;
    const mine = paused;
    paused = null;
    if (
      state.currentChannelId !== mine.channelId ||
      state.joinedAt !== mine.joinedAt ||
      state.localCamera
    ) {
      return;
    }
    const { enableCamera } = await import("../../lib/voice/livekitSession");
    await enableCamera();
  };

  const enqueue = (step: () => Promise<void>, what: string): void => {
    chain = chain.then(step).catch((e: unknown) => log.warn(`Failed to ${what} the camera`, e));
  };

  const onVisibility = (): void => {
    if (hidden()) enqueue(pause, "pause");
    else enqueue(resume, "resume");
  };
  document.addEventListener("visibilitychange", onVisibility, { signal });

  const stop = voiceStore.subscribeSelector(
    (state) => `${state.currentChannelId ?? ""}:${state.joinedAt ?? ""}`,
    () => {
      paused = null;
    },
  );
  // A reconnect can swallow a visibility change: settle it once connected.
  const stopStatus = voiceStore.subscribeSelector(
    (state) => state.voiceStatus,
    (status) => {
      if (status === "connected") onVisibility();
    },
  );
  signal.addEventListener(
    "abort",
    () => {
      stop();
      stopStatus();
    },
    { once: true },
  );
}
