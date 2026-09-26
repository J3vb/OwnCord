import { describe, it, expect, vi, afterEach } from "vitest";
import {
  sessionDeviceLabel,
  sessionNoticeMessage,
  startSessionNotice,
} from "../../src/lib/session-notice";
import type { SessionInfo } from "../../src/lib/api";

// B7-14: listing the sessions IS the acknowledgement — the server returns the
// flags as they were and clears them in the same request. So the notice must
// fire from that one response; a second listing never sees the flag again.

function session(patch: Partial<SessionInfo>): SessionInfo {
  return {
    id: 1,
    device: "OwnCord-Client/1.4.0",
    ip: "198.51.100.2",
    created_at: "2026-09-21 08:00:00",
    last_used: "2026-09-21 08:00:00",
    is_current: false,
    unseen: false,
    ...patch,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("startSessionNotice", () => {
  const controllers: AbortController[] = [];
  afterEach(() => {
    for (const c of controllers) c.abort();
    controllers.length = 0;
  });

  function start(responses: SessionInfo[][]) {
    const ac = new AbortController();
    controllers.push(ac);
    const fetchSessions = vi.fn((_signal: AbortSignal) => Promise.resolve(responses.shift() ?? []));
    const notify = vi.fn();
    const poll = startSessionNotice({ fetchSessions, notify, signal: ac.signal });
    return { ac, fetchSessions, notify, poll };
  }

  it("notifies from the one listing that carries an unseen sign-in", async () => {
    const other = session({ id: 2, unseen: true });
    // The second listing is what the server returns once the first cleared it.
    const { notify, poll } = start([[other], [{ ...other, unseen: false }]]);
    await flush();
    expect(notify).toHaveBeenCalledExactlyOnceWith([other]);

    poll();
    await flush();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("ignores this device's own row, which its own listing never clears", async () => {
    const { notify } = start([[session({ id: 3, is_current: true, unseen: true })]]);
    await flush();
    expect(notify).not.toHaveBeenCalled();
  });

  it("lists again on window focus and when the document becomes visible", async () => {
    const { fetchSessions } = start([]);
    await flush();
    expect(fetchSessions).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    await flush();
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(fetchSessions).toHaveBeenCalledTimes(3);
  });

  it("runs one listing at a time when focus and visibility fire together", async () => {
    const { fetchSessions } = start([]);
    await flush();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(fetchSessions).toHaveBeenCalledTimes(2);
  });

  it("stops listening once aborted", async () => {
    const { ac, fetchSessions, poll } = start([]);
    await flush();
    ac.abort();
    window.dispatchEvent(new Event("focus"));
    poll();
    await flush();
    expect(fetchSessions).toHaveBeenCalledTimes(1);
  });
});

describe("session labels", () => {
  it("names both desktop User-Agents as the desktop app", () => {
    expect(sessionDeviceLabel("OwnCord-Client/1.4.0")).toBe("OwnCord desktop");
    expect(sessionDeviceLabel("tauri-plugin-http/2.6.0")).toBe("OwnCord desktop");
    expect(sessionDeviceLabel("")).toBe("Unknown device");
    expect(sessionDeviceLabel("curl/8.0")).toBe("curl/8.0");
  });

  it("names which sign-in and where to review it, not a 'new' one", () => {
    const msg = sessionNoticeMessage([session({ id: 2, ip: "198.51.100.2" }), session({ id: 1 })]);
    expect(msg).toContain("not reviewed");
    expect(msg).toContain("OwnCord desktop from 198.51.100.2");
    expect(msg).toContain("and 1 more");
    expect(msg).toContain("Settings > Account");
    expect(msg).not.toMatch(/\bnew\b/i);
  });
});
