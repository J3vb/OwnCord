// The chat and server baseline, against the real server: how long a message
// takes to be acknowledged and to reach the other user, how long a channel
// switch takes to show the right history (cold and warm), how long uploads of
// fixed-content files take, and how long the client needs to be live again
// after a server restart. A measuring tool, not a gate: the name keeps it out
// of the fullstack run, and `npm run test:e2e:chat-perf` runs it. Rows go to
// test-results/perf/non-media-performance.jsonl; summarize them with
// `node scripts/analyze-perf.mjs`. Synthetic content only.
//
//   OWNCORD_PERF_TRIALS     trials per scenario (default 10)
//   OWNCORD_PERF_HISTORY    messages in the seeded channel (default 200)
//   OWNCORD_PERF_UPLOAD_KB  upload sizes in KiB, comma separated (default 256,1024)
//   OWNCORD_PERF_ONLY       run only these parts: send,switch,upload,restart
//   OWNCORD_PERF_RESTARTS   server restarts per run (default 3)
//   OWNCORD_PERF_ARM, OWNCORD_PERF_SEED  see support/perf-run.ts
import type { Page } from "@playwright/test";
import {
  armAppearance,
  armEvent,
  clockAt,
  elapsed,
  portClosed,
  seededFile,
} from "../support/non-media-performance";
import { PERF_SEED, PERF_TRIALS, startPerfRun, type PerfRun } from "../support/perf-run";
import { rawSocket } from "../support/raw-socket";
import type { installRealTransport } from "../support/real-transport";
import type { TestServer } from "../support/server";
import { test, expect } from "./fixtures";
import { channelIdByName, channelItem, generalId } from "./serverApi";

const HISTORY = Number(process.env.OWNCORD_PERF_HISTORY ?? 200);
const UPLOAD_KB = (process.env.OWNCORD_PERF_UPLOAD_KB ?? "256,1024").split(",").map(Number);
const RESTARTS = Number(process.env.OWNCORD_PERF_RESTARTS ?? 3);
const ONLY = process.env.OWNCORD_PERF_ONLY?.split(",");
const runs = (part: string) => ONLY === undefined || ONLY.includes(part);

test.setTimeout(PERF_TRIALS * (3 + UPLOAD_KB.length) * 20_000 + RESTARTS * 90_000 + 240_000);

const composer = (page: Page) => page.locator("[data-testid='message-input']");
const row = (text: string) => ({ selector: ".messages-container .message", text });
const ackedRow = (text: string) => ({
  selector: ".messages-container .message:not(.pending):not(.failed)",
  text,
});

async function sendTrials(
  run: PerfRun,
  alice: Page,
  bob: Page,
  aliceTransport: Awaited<ReturnType<typeof installRealTransport>>,
) {
  for (let trial = 0; trial < PERF_TRIALS; trial++) {
    const content = `perf-send-${PERF_SEED}-${trial}-${crypto.randomUUID().slice(0, 8)}`;
    let sentAt: number | null = null;
    let commandId: string | undefined;
    let ackAt: number | null = null;
    aliceTransport.observeClientMessages((m) => {
      if (m.type !== "chat_send" || m.payload?.content !== content) return;
      sentAt = performance.timeOrigin + performance.now();
      commandId = m.id;
    });
    aliceTransport.filterServerMessages((m) => {
      if (m.type === "chat_send_ok" && commandId !== undefined && m.id === commandId)
        ackAt ??= performance.timeOrigin + performance.now();
      return true;
    });
    // The composer ignores an Enter within 200 ms of the last send, so the
    // trials are spaced out; a typed-but-unsent message is not a slow one.
    if (trial > 0) await alice.waitForTimeout(250);
    await composer(alice).locator("textarea").fill(content);
    await armEvent(alice, "enter", "keydown", "[data-testid='message-input'] textarea");
    await armAppearance(alice, "acked", ackedRow(content));
    await armAppearance(bob, "peer", row(content));
    await composer(alice).locator("textarea").press("Enter");
    const enter = await clockAt(alice, "enter");
    const acked = await clockAt(alice, "acked");
    const peer = await clockAt(bob, "peer");
    const ok = acked !== null && peer !== null;
    await expect(composer(alice).locator("textarea")).toHaveValue("");
    run.trial({
      scenario: "send",
      trial,
      status: ok ? "ok" : "failed",
      reason: ok ? undefined : "the message did not show as sent for both users within 30 s",
      metrics: {
        wireAckMs: sentAt !== null && ackAt !== null ? Number((ackAt - sentAt).toFixed(1)) : null,
        enterToAckedMs: elapsed(enter, acked),
        enterToPeerMs: elapsed(enter, peer),
      },
    });
  }
  aliceTransport.observeClientMessages();
  aliceTransport.filterServerMessages();
}

/**
 * Opens `name` and times the click to its own marker message being on
 * screen. Waiting for that channel's marker, not for any rows, keeps the
 * previous channel's history from ending the clock early.
 */
async function switchTo(page: Page, name: string, marker: string): Promise<number | null> {
  await armEvent(page, "click", "click", ".channel-item");
  await armAppearance(page, "marker", row(marker));
  await channelItem(page, name).click();
  const clicked = await clockAt(page, "click");
  const shown = await clockAt(page, "marker");
  await expect(channelItem(page, name)).toHaveClass(/active/);
  return elapsed(clicked, shown);
}

async function switchTrials(run: PerfRun, bob: Page, server: TestServer) {
  await server.api("/admin/api/channels", { name: "history", type: "text" }, server.owner!.token);
  const history = await channelIdByName(server, "history");
  const general = await generalId(server);
  const markers = {
    history: `perf-marker-history-${PERF_SEED}`,
    general: `perf-marker-general-${PERF_SEED}`,
  };
  const poster = await rawSocket(server, "alice");
  try {
    const texts = Array.from({ length: HISTORY - 1 }, (_, i) => `perf-history-${PERF_SEED}-${i}`);
    await poster.post(history, [...texts, markers.history]);
    await poster.post(general, [markers.general]);
  } finally {
    poster.close();
  }
  await expect(
    bob.locator(".messages-container .message", { hasText: markers.general }),
  ).toHaveCount(1);
  for (let trial = 0; trial < PERF_TRIALS; trial++) {
    const ms = await switchTo(bob, "history", markers.history);
    run.trial({
      scenario: trial === 0 ? "channel-switch-cold" : "channel-switch-warm",
      trial,
      status: ms === null ? "failed" : "ok",
      reason: ms === null ? "the channel's newest message was not shown within 30 s" : undefined,
      metrics: { switchMs: ms, historyMessages: HISTORY },
    });
    const back = await switchTo(bob, "general", markers.general);
    run.trial({
      scenario: "channel-switch-back",
      trial,
      status: back === null ? "failed" : "ok",
      metrics: { switchMs: back },
    });
  }
}

async function uploadTrials(run: PerfRun, alice: Page, bob: Page) {
  for (const kb of UPLOAD_KB) {
    for (let trial = 0; trial < PERF_TRIALS; trial++) {
      const file = seededFile(PERF_SEED + kb * 1000 + trial, kb * 1024);
      const name = `perf-${kb}k-${trial}-${file.sha256.slice(0, 8)}.bin`;
      const text = `perf-upload-${PERF_SEED}-${kb}-${trial}`;
      const box = composer(alice);
      await armEvent(alice, "picked", "change", "input[data-attach-source='files']");
      await armAppearance(alice, "uploaded", {
        selector: "[data-testid='message-input'] .attachment-preview-item:not(.uploading)",
      });
      await box.locator("input[data-attach-source='files']").setInputFiles({
        name,
        mimeType: "application/octet-stream",
        buffer: file.buffer,
      });
      const picked = await clockAt(alice, "picked");
      const uploaded = await clockAt(alice, "uploaded");
      await box.locator("textarea").fill(text);
      await armEvent(alice, "enter", "keydown", "[data-testid='message-input'] textarea");
      await armAppearance(bob, "peer", {
        selector: ".messages-container .msg-file-name",
        text: name,
      });
      await box.locator("textarea").press("Enter");
      const enter = await clockAt(alice, "enter");
      const peer = await clockAt(bob, "peer");
      const uploadMs = elapsed(picked, uploaded);
      const ok = uploadMs !== null && peer !== null;
      run.trial({
        scenario: `upload-${kb}k`,
        trial,
        status: ok ? "ok" : "failed",
        reason: ok
          ? undefined
          : picked === null
            ? "the file picker change was not seen"
            : uploadMs === null
              ? "the upload did not finish within 30 s"
              : "the message did not reach the other user within 30 s",
        metrics: {
          uploadMs,
          uploadKbps: uploadMs ? Math.round((kb * 1024 * 8) / uploadMs) : null,
          enterToPeerMs: elapsed(enter, peer),
          bytes: kb * 1024,
        },
        info: { sha256: file.sha256 },
      });
      await expect(alice.locator(".message.pending, .message.failed")).toHaveCount(0);
    }
  }
}

async function restartTrials(run: PerfRun, alice: Page, bob: Page, server: TestServer) {
  const general = await generalId(server);
  for (let trial = 0; trial < RESTARTS; trial++) {
    // Only a client proven live before the restart can measure coming back:
    // a message posted now must reach it over its socket.
    const before = `perf-live-${PERF_SEED}-${trial}`;
    const poster = await rawSocket(server, "bob");
    await poster.post(general, [before]);
    poster.close();
    await expect(alice.locator(".messages-container .message", { hasText: before })).toHaveCount(1);
    await expect(alice.locator(".reconnecting-banner")).not.toHaveClass(/visible/);

    let downAt: number | null = null;
    let wasDown = false;
    await server.restart(async () => {
      // The clock starts only once nothing accepts connections, so a restart
      // that has not really happened yet cannot count as a fast one.
      wasDown = await portClosed(server.port);
      downAt = Date.now();
    });
    const upAt = Date.now();
    const after = `perf-back-${PERF_SEED}-${trial}`;
    await armAppearance(alice, "back", row(after), 60_000);
    const poster2 = await rawSocket(server, "bob");
    await poster2.post(general, [after]);
    poster2.close();
    const back = await clockAt(alice, "back");
    const ok = wasDown && back !== null;
    run.trial({
      scenario: "server-restart",
      trial,
      status: ok ? "ok" : "failed",
      reason: !wasDown
        ? "the port still accepted connections"
        : back === null
          ? "not live within 60 s"
          : undefined,
      metrics: { serverDownMs: elapsed(downAt, upAt), upToClientLiveMs: elapsed(upAt, back) },
    });
    for (const page of [alice, bob])
      await expect(page.locator(".reconnecting-banner")).not.toHaveClass(/visible/, {
        timeout: 60_000,
      });
  }
}

test("chat and server baseline", async ({ alice, bob, aliceTransport, server, browser }) => {
  const run = startPerfRun("non-media-performance", browser, {
    trials: PERF_TRIALS,
    historyMessages: HISTORY,
    uploadKb: UPLOAD_KB.join(","),
    restarts: RESTARTS,
  });
  if (runs("send")) await sendTrials(run, alice, bob, aliceTransport);
  if (runs("switch")) await switchTrials(run, bob, server);
  if (runs("upload")) await uploadTrials(run, alice, bob);
  if (runs("restart")) await restartTrials(run, alice, bob, server);
  for (const [scenario, reason] of [
    [
      "native-desktop",
      "the Tauri desktop app and its native transport are not in the browser lane",
    ],
    ["network-shaping", "loopback only; slow and lossy links need a namespace or gateway"],
    ["upload-interruption", "interrupted uploads are not measured yet"],
  ] as const)
    run.trial({ scenario, trial: 0, status: "unverified", reason });
  test.info().annotations.push({ type: "perf-run", description: `${run.id} seed ${PERF_SEED}` });
});
