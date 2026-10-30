import { describe, it, expect, vi } from "vitest";
import * as dispatcherMocks from "../../helpers/dispatcherMocks";
import { setActivityRefusalHandler } from "../../../src/lib/presence/gameActivityBridge";
import { expectConsole } from "../../helpers/console";
import { authStore } from "../../../src/stores/auth.store";
import {
  messagesStore,
  addOptimisticMessage,
  getChannelMessages,
} from "../../../src/stores/messages.store";
import { membersStore } from "../../../src/stores/members.store";
import { dmStore } from "../../../src/stores/dm.store";
import { blocksStore } from "../../../src/stores/blocks.store";
import { uiStore } from "../../../src/stores/ui.store";
import { safetyText } from "../../../src/i18n/safety";
import { createPresenceSender, setActivePresenceSender } from "../../../src/lib/presence/presence";
import { createPresenceLimiter } from "../../../src/lib/net/rateLimiter";
import { loadCustomStatus, saveCustomStatus } from "../../../src/lib/presence/userStatus";
import { useDispatcherHarness, type DispatcherMock } from "../../helpers/dispatcherHarness";

vi.mock("@lib/notifications", () => dispatcherMocks.notificationsMock());
vi.mock("@lib/voice/livekitSession", () => dispatcherMocks.livekitSessionMock());
vi.mock("@lib/voice/screenShare", () => dispatcherMocks.screenShareMock());
vi.mock("@lib/ui/toast", () => dispatcherMocks.toastMock());
vi.mock("@lib/net/identity", () => dispatcherMocks.identityMock());
vi.mock("../../../src/features/connection/dispatchContext", async (importOriginal) =>
  dispatcherMocks.dispatchContextMock(await importOriginal<object>()),
);

const { mockShowToast } = dispatcherMocks;

describe("WS Dispatcher", () => {
  let cleanup: () => void;
  let mock: DispatcherMock;

  useDispatcherHarness({
    wired: (m, c) => {
      mock = m;
      cleanup = c;
    },
    currentCleanup: () => cleanup,
  });

  it("wires error BANNED to clear auth and show error", () => {
    authStore.setState((prev) => ({
      ...prev,
      isAuthenticated: true,
      user: { id: 1, username: "banned-user", avatar: null, role: "member" },
    }));

    mock.dispatch("error", {
      code: "BANNED",
      message: "You have been banned from this server",
    });
    expectConsole("error", /\[dispatcher\] Server error/);

    expect(authStore.getState().isAuthenticated).toBe(false);
    const error = uiStore.getState().transientError;
    expect(error).toBe(`You have been banned. ${safetyText("appeals.unavailable")}`);
    expect(error).toContain("contact the server's operator directly");
  });

  it("wires error BANNED with empty message uses default", () => {
    mock.dispatch("error", { code: "BANNED", message: "" });
    expectConsole("error", /\[dispatcher\] Server error/);
    const error = uiStore.getState().transientError;
    expect(error).toBe(`You have been banned. ${safetyText("appeals.unavailable")}`);
  });

  it("wires error BANNED to disconnect the ws client (without this the banned token reconnects forever)", () => {
    authStore.setState((prev) => ({
      ...prev,
      isAuthenticated: true,
      user: { id: 1, username: "banned-user", avatar: null, role: "member" },
    }));

    mock.dispatch("error", {
      code: "BANNED",
      message: "You have been banned from this server",
    });
    expectConsole("error", /\[dispatcher\] Server error/);

    // clearAuth() alone flips isAuthenticated, but main.ts's authStore
    // subscriber only tears down the ws (and cancels the reconnect loop) when
    // the router is already on "main". During login / auto-login / the
    // connected-overlay window it is not, so the BANNED handler itself must
    // call ws.disconnect() to set intentionalClose and stop scheduleReconnect
    // from redialing with the now-cleared but still-cached banned token.
    expect(mock.ws.disconnect).toHaveBeenCalled();
  });

  // OC-0064: transientError has exactly one reader in the whole client —
  // ConnectPage's login-screen subscription. Routing the catch-all fallback
  // through it means an error raised while the user is in-app (MainPage
  // never subscribes) is invisible until the user later lands back on the
  // login screen, where it resurfaces stale and out of context. The
  // catch-all must use the same in-app toast the sibling CHANNEL_FULL /
  // VIDEO_LIMIT branches already use, and must leave transientError alone.
  it("wires error RATE_LIMITED to an in-app toast with its catalog text", () => {
    mockShowToast.mockClear();
    mock.dispatch("error", {
      code: "RATE_LIMITED",
      message: "too many requests, please slow down",
    });
    expectConsole("error", /\[dispatcher\] Server error/);

    expect(mockShowToast).toHaveBeenCalledWith("Too many requests. Try again later.", "error");
    expect(uiStore.getState().transientError).toBeNull();
  });

  it("lets the game activity loop claim its own refused frame without a toast", () => {
    mockShowToast.mockClear();
    setActivityRefusalHandler((code, id) => code === "RATE_LIMITED" && id === "act-1");
    try {
      mock.dispatch("error", { code: "RATE_LIMITED", message: "slow down" }, "act-1");
      expectConsole("error", /\[dispatcher\] Server error/);
      expect(mockShowToast).not.toHaveBeenCalled();

      // Any other frame's RATE_LIMITED still reaches the user.
      mock.dispatch("error", { code: "RATE_LIMITED", message: "slow down" }, "chat-9");
      expectConsole("error", /\[dispatcher\] Server error/);
      expect(mockShowToast).toHaveBeenCalledWith("Too many requests. Try again later.", "error");
    } finally {
      setActivityRefusalHandler(null);
    }
  });

  it("wires error FORBIDDEN to an in-app toast with its catalog text", () => {
    mockShowToast.mockClear();
    mock.dispatch("error", {
      code: "FORBIDDEN",
      message: "Insufficient permissions",
    });
    expectConsole("error", /\[dispatcher\] Server error/);

    expect(mockShowToast).toHaveBeenCalledWith("You don't have permission to do that.", "error");
    expect(uiStore.getState().transientError).toBeNull();
  });

  it("wires error RATE_LIMITED with empty message to its catalog text", () => {
    mockShowToast.mockClear();
    mock.dispatch("error", { code: "RATE_LIMITED", message: "" });
    expectConsole("error", /\[dispatcher\] Server error/);
    expect(mockShowToast).toHaveBeenCalledWith("Too many requests. Try again later.", "error");
    expect(uiStore.getState().transientError).toBeNull();
  });

  it("wires an unmapped error with an empty message to the generic fallback toast", () => {
    mockShowToast.mockClear();
    mock.dispatch("error", { code: "SOMETHING_ODD", message: "" });
    expectConsole("error", /\[dispatcher\] Server error/);
    expect(mockShowToast).toHaveBeenCalledWith("Server error", "error");
  });

  it("wires error INTERNAL to the generic fallback toast, never the server's message", () => {
    mockShowToast.mockClear();
    mock.dispatch("error", { code: "INTERNAL", message: "db: sqlite busy" });
    expectConsole("error", /\[dispatcher\] Server error/);
    expect(mockShowToast).toHaveBeenCalledWith("Server error", "error");
  });

  // A timeout refuses a custom status without writing or broadcasting
  // anything, so the PresenceSender's optimistic apply would leave the user
  // seeing and saving a status nobody else has. The dispatcher is the one
  // writer for server events, so its error chain routes the rollback to the
  // active sender.
  it("rolls back the optimistic presence status on a TIMED_OUT refusal", () => {
    const presenceSender = createPresenceSender(mock.ws, createPresenceLimiter());
    setActivePresenceSender(presenceSender);
    try {
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 1, username: "alice", avatar: null, role: "member" },
      }));
      membersStore.setState((prev) => ({
        ...prev,
        members: new Map([
          [
            1,
            {
              id: 1,
              username: "alice",
              avatar: null,
              role: "member",
              status: "online",
              customStatus: "old text",
            } as never,
          ],
        ]),
      }));
      saveCustomStatus("old text");
      saveCustomStatus("new text");
      presenceSender.send("dnd", "new text");
      const id = (mock.ws.send as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as string;

      mock.dispatch("error", { code: "TIMED_OUT", message: "you are timed out" }, id);
      expectConsole("error", /\[dispatcher\] Server error/);

      expect(membersStore.getState().members.get(1)?.status).toBe("online");
      expect(membersStore.getState().members.get(1)?.customStatus).toBe("old text");
      expect(loadCustomStatus()).toBe("old text");
    } finally {
      setActivePresenceSender(null);
      presenceSender.destroy();
    }
  });

  it("rolls back the optimistic presence status on a REQUEST_TIMEOUT refusal", () => {
    const presenceSender = createPresenceSender(mock.ws, createPresenceLimiter());
    setActivePresenceSender(presenceSender);
    try {
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 1, username: "alice", avatar: null, role: "member" },
      }));
      membersStore.setState((prev) => ({
        ...prev,
        members: new Map([
          [
            1,
            {
              id: 1,
              username: "alice",
              avatar: null,
              role: "member",
              status: "online",
              customStatus: "old text",
            } as never,
          ],
        ]),
      }));
      saveCustomStatus("old text");
      saveCustomStatus("new text");
      presenceSender.send("dnd", "new text");
      const id = (mock.ws.send as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as string;

      mock.dispatch("error", { code: "REQUEST_TIMEOUT", message: "the server is busy" }, id);
      expectConsole("error", /\[dispatcher\] Server error/);

      expect(membersStore.getState().members.get(1)?.status).toBe("online");
      expect(membersStore.getState().members.get(1)?.customStatus).toBe("old text");
      expect(loadCustomStatus()).toBe("old text");
    } finally {
      setActivePresenceSender(null);
      presenceSender.destroy();
    }
  });

  // WP 3C-9: a custom status the server's character or length rules refuse
  // comes back BAD_REQUEST; the optimistic value must not stay on screen, and
  // the toast carries the server's own text.
  it("rolls back the optimistic custom status on a BAD_REQUEST refusal and toasts the server's text", () => {
    const presenceSender = createPresenceSender(mock.ws, createPresenceLimiter());
    setActivePresenceSender(presenceSender);
    try {
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 1, username: "alice", avatar: null, role: "member" },
      }));
      membersStore.setState((prev) => ({
        ...prev,
        members: new Map([
          [
            1,
            {
              id: 1,
              username: "alice",
              avatar: null,
              role: "member",
              status: "online",
              customStatus: "old text",
            } as never,
          ],
        ]),
      }));
      saveCustomStatus("old text");
      saveCustomStatus("bad\u202etext");
      presenceSender.send("online", "bad\u202etext");
      const id = (mock.ws.send as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as string;

      mockShowToast.mockClear();
      mock.dispatch(
        "error",
        { code: "BAD_REQUEST", message: "custom_status must not contain invisible characters" },
        id,
      );
      expectConsole("error", /\[dispatcher\] Server error/);

      expect(membersStore.getState().members.get(1)?.customStatus).toBe("old text");
      expect(loadCustomStatus()).toBe("old text");
      expect(mockShowToast).toHaveBeenCalledWith(
        "Custom_status must not contain invisible characters",
        "error",
      );
    } finally {
      setActivePresenceSender(null);
      presenceSender.destroy();
    }
  });

  it("wires error with an unrecognized code to the generic fallback toast", () => {
    // The final fallthrough is the one place every unmatched error code
    // lands (e.g. a rejected fire-and-forget chat_edit) — it must not be
    // silently dropped just because it isn't RATE_LIMITED/FORBIDDEN.
    mockShowToast.mockClear();
    uiStore.setState((prev) => ({ ...prev, transientError: null }));

    mock.dispatch("error", {
      code: "UNKNOWN",
      message: "Something odd",
    });
    expectConsole("error", /\[dispatcher\] Server error/);

    expect(mockShowToast).toHaveBeenCalledWith("Something odd", "error");
    expect(uiStore.getState().transientError).toBeNull();
  });

  it("wires a BAD_REQUEST error with no pending correlation (e.g. a rejected chat_edit) to an in-app toast", () => {
    // chat_edit is fire-and-forget: it never enters pendingSends, so a
    // rejection's envelope id matches nothing above and used to fall through
    // this handler silently, leaving the user's edited text destroyed with
    // no error shown (only RATE_LIMITED/FORBIDDEN were bannered).
    mockShowToast.mockClear();
    uiStore.setState((prev) => ({ ...prev, transientError: null }));

    mock.dispatch("error", { code: "BAD_REQUEST", message: "Message too long" }, "edit-id-1");
    expectConsole("error", /\[dispatcher\] Server error/);

    expect(mockShowToast).toHaveBeenCalledWith("Message too long", "error");
    expect(uiStore.getState().transientError).toBeNull();
  });

  it("wires an error carrying a pending send id to mark that row failed (not a toast)", () => {
    messagesStore.setState(() => ({
      messagesByChannel: new Map(),
      pendingSends: new Map(),
      loadedChannels: new Set(),
      hasMore: new Map(),
      historyLoadState: new Map(),
      detachedChannels: new Set(),
    }));
    uiStore.setState((prev) => ({ ...prev, transientError: null }));

    addOptimisticMessage({
      correlationId: "corr-1",
      channelId: 7,
      user: { id: 1, username: "alex", avatar: null },
      content: "hi",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });

    // Error echoes the request id → the specific row is marked failed…
    mock.dispatch("error", { code: "SLOW_MODE", message: "slow down" }, "corr-1");
    expectConsole("error", /\[dispatcher\] Server error/);

    const row = getChannelMessages(7)[0]!;
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("SLOW_MODE");
    // …and it is not surfaced as a global transient error.
    expect(uiStore.getState().transientError).toBeNull();
  });

  it("gates the DM composer (blockedByThem) when a DM send is refused with FORBIDDEN", () => {
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 7,
          recipient: { id: 5, username: "alice", avatar: "", status: "online" },
          participants: [],
          name: "",
          isGroup: false,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));
    addOptimisticMessage({
      correlationId: "corr-dm",
      channelId: 7,
      user: { id: 1, username: "alex", avatar: null },
      content: "hi",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });

    mock.dispatch("error", { code: "FORBIDDEN", message: "blocked" }, "corr-dm");
    expectConsole("error", /\[dispatcher\] Server error/);

    expect(blocksStore.getState().blockedByThem.has(5)).toBe(true);
    // Still marks the row failed (existing behaviour preserved).
    expect(getChannelMessages(7)[0]!.status).toBe("failed");
  });

  it("does not gate on a FORBIDDEN send outside a DM channel", () => {
    // channel 7 is not in dmStore → no block state is inferred.
    addOptimisticMessage({
      correlationId: "corr-nondm",
      channelId: 7,
      user: { id: 1, username: "alex", avatar: null },
      content: "hi",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });

    mock.dispatch("error", { code: "FORBIDDEN", message: "nope" }, "corr-nondm");
    expectConsole("error", /\[dispatcher\] Server error/);

    expect(blocksStore.getState().blockedByThem.size).toBe(0);
  });

  it("does not gate blockedByThem on a FORBIDDEN send in a group DM", () => {
    // Group DMs are exempt from block checks server-side (a group FORBIDDEN
    // means something else, e.g. stale membership) — recipient is just
    // participants[0] for a group, so flagging it here would incorrectly
    // gate an unrelated 1:1 DM with that same person.
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 8,
          recipient: { id: 5, username: "alice", avatar: "", status: "online" },
          participants: [
            { id: 5, username: "alice", avatar: "", status: "online" },
            { id: 6, username: "bob", avatar: "", status: "online" },
          ],
          name: "Crew",
          isGroup: true,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));
    addOptimisticMessage({
      correlationId: "corr-group",
      channelId: 8,
      user: { id: 1, username: "alex", avatar: null },
      content: "hi",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });

    mock.dispatch("error", { code: "FORBIDDEN", message: "not a participant" }, "corr-group");
    expectConsole("error", /\[dispatcher\] Server error/);

    expect(blocksStore.getState().blockedByThem.has(5)).toBe(false);
    // Still marks the row failed (existing behaviour preserved).
    expect(getChannelMessages(8)[0]!.status).toBe("failed");
  });
});
