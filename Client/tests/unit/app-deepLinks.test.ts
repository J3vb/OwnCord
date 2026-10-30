/**
 * Tests for src/app/deepLinks.ts (WP 7.4k). The handlers are reached the way
 * main.ts reaches them: installDeepLinks() registers them, and the test takes
 * them from the mocked desktop.deepLinks.init and from the invite-join
 * registration. The router is real (over a mocked connect route), so an invite
 * is observed landing on the connect page's hook or in its take-once closure.
 * The session controller is a stand-in, and clearAuth is a spy that navigates
 * to connect the way the logout subscriber in session.ts does.
 *
 * Edge case E2 (an invite link with the connect page mounted versus not
 * mounted) is pinned here from the handler's side; the router's own side is in
 * app-router.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@lib/api";
import type { ProfileManager } from "@lib/presence/profiles";
import type { WsClient } from "@lib/ws";

type PendingInvite = { code: string; host?: string } | null;
type InviteHandler = (code: string, host?: string) => void;
type MessageHandler = (channelId: number, messageId: number | undefined, host?: string) => void;

const hoisted = vi.hoisted(() => ({
  events: [] as string[],
  applyInvite: vi.fn(),
  renderConnect: vi.fn(),
  inFlight: false,
  clearAuth: vi.fn(),
  deactivatePendingMessages: vi.fn(),
  openMessageTarget: vi.fn(),
  confirmInviteJoin: vi.fn(),
  warn: vi.fn(),
  init: vi.fn(),
  setInviteJoinHandler: vi.fn(),
}));
const { events } = hoisted;

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: hoisted.warn, error: vi.fn() }),
}));
vi.mock("@lib/pendingMessages", () => ({
  deactivatePendingMessages: hoisted.deactivatePendingMessages,
}));
vi.mock("@lib/notifications", () => ({ openMessageTarget: hoisted.openMessageTarget }));
vi.mock("@lib/nav/inviteNavigation", () => ({
  setInviteJoinHandler: hoisted.setInviteJoinHandler,
}));
vi.mock("../../src/platform/desktop", () => ({ desktop: { deepLinks: { init: hoisted.init } } }));
vi.mock("../../src/app/serverHealth", () => ({ serverInfoFor: vi.fn(() => undefined) }));
vi.mock("../../src/app/session", () => ({
  sessionInFlight: () => hoisted.inFlight,
  abandonInFlight: () => events.push("abandonInFlight"),
}));
vi.mock("../../src/app/connectRoute", () => ({
  renderConnect: (...args: unknown[]) => {
    hoisted.renderConnect(...args);
    return [{ destroy: vi.fn() }, vi.fn(), hoisted.applyInvite];
  },
}));
vi.mock("@stores/auth.store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stores/auth.store")>()),
  clearAuth: (...args: unknown[]) => hoisted.clearAuth(...args),
}));
vi.mock("@components/InviteJoinConfirm", () => ({
  confirmInviteJoin: hoisted.confirmInviteJoin,
}));

// Imported after each vi.resetModules(), so they are the instances deepLinks.ts sees.
let authStore: typeof import("@stores/auth.store").authStore;
let setAuth: typeof import("@stores/auth.store").setAuth;
let joinVoiceChannel: typeof import("@stores/voice.store").joinVoiceChannel;
let leaveVoiceChannel: typeof import("@stores/voice.store").leaveVoiceChannel;
let router: typeof import("../../src/app/router");
let invite: InviteHandler;
let message: MessageHandler;
let joinFromChat: InviteHandler;
/** The take-once closure the mounted connect page was given. */
let mountedTake: () => PendingInvite;
const endSession = vi.fn(() => {
  events.push("endSession");
});
const getConfig = vi.fn(() => ({ host: "current.example" }));

const USER = { id: 1, username: "alex", avatar: null, role: "member" } as const;

const lastTakePendingInvite = (): (() => PendingInvite) =>
  hoisted.renderConnect.mock.lastCall![5] as () => PendingInvite;

/** Lets a lazy import and the promise chain after it settle. */
async function settle(): Promise<void> {
  await vi.waitFor(() => undefined);
  await new Promise((r) => setTimeout(r, 0));
}

/** Puts the router on the main page without loading it. */
async function goToMain(): Promise<void> {
  vi.doMock("@pages/MainPage", () => ({
    createMainPage: () => ({ mount: vi.fn(), destroy: vi.fn() }),
  }));
  router.navigate("main");
  await settle();
  hoisted.renderConnect.mockClear();
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  events.length = 0;
  hoisted.applyInvite.mockImplementation(() => events.push("applyInvite"));
  ({ authStore, setAuth } = await import("@stores/auth.store"));
  ({ joinVoiceChannel, leaveVoiceChannel } = await import("@stores/voice.store"));
  hoisted.inFlight = false;
  authStore.setState((s) => ({ ...s, isAuthenticated: false, serverName: null }));
  leaveVoiceChannel();
  document.body.innerHTML = '<div id="app"></div>';
  router = await import("../../src/app/router");
  router.configureRouter(
    { getConfig } as unknown as ApiClient,
    {} as WsClient,
    document.getElementById("app")!,
    {} as ProfileManager,
    vi.fn(),
  );
  // The logout subscriber navigates to connect once clearAuth runs on main.
  hoisted.clearAuth.mockImplementation(() => {
    events.push("clearAuth");
    router.navigate("connect");
  });
  await router.renderActive();
  mountedTake = lastTakePendingInvite();
  hoisted.renderConnect.mockClear();
  const { installDeepLinks } = await import("../../src/app/deepLinks");
  installDeepLinks({ endSession, getConfig } as unknown as ApiClient);
  [invite, message] = hoisted.init.mock.lastCall as [InviteHandler, MessageHandler];
  joinFromChat = hoisted.setInviteJoinHandler.mock.lastCall![0] as InviteHandler;
});

describe("installDeepLinks", () => {
  it("registers the in-chat invite handler before the native listener", async () => {
    vi.resetModules();
    const order: string[] = [];
    hoisted.setInviteJoinHandler.mockImplementationOnce(() => order.push("setInviteJoinHandler"));
    hoisted.init.mockImplementationOnce(() => order.push("init"));
    const { installDeepLinks } = await import("../../src/app/deepLinks");
    installDeepLinks({ endSession, getConfig } as unknown as ApiClient);
    expect(order).toEqual(["setInviteJoinHandler", "init"]);
  });

  it("hands a message permalink to the notification jumper", () => {
    message(7, 42, "h.example");
    expect(hoisted.openMessageTarget).toHaveBeenCalledWith(7, 42, "h.example");
    message(8, undefined);
    expect(hoisted.openMessageTarget).toHaveBeenLastCalledWith(8, undefined, undefined);
  });
});

describe("E2: an invite link with the connect page mounted", () => {
  it("applies it straight to the page, once, and leaves nothing pending", () => {
    invite("ABC123", "h.example");

    expect(hoisted.applyInvite).toHaveBeenCalledTimes(1);
    expect(hoisted.applyInvite).toHaveBeenCalledWith("ABC123", "h.example");
    // The connect page was not re-rendered, and its take-once closure is empty.
    expect(hoisted.renderConnect).not.toHaveBeenCalled();
    expect(mountedTake()).toBeNull();
    expect(hoisted.clearAuth).not.toHaveBeenCalled();
  });

  it("ends the api session and drops pending sends before applying it", () => {
    invite("ABC123");
    expect(hoisted.deactivatePendingMessages).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it("tears an in-flight session down after endSession, and clears an authenticated one", () => {
    hoisted.inFlight = true;
    setAuth("tok", USER, "Srv", "");
    joinFromChat("ABC123");

    expect(events).toEqual(["endSession", "abandonInFlight", "clearAuth", "applyInvite"]);
    expect(hoisted.clearAuth).toHaveBeenCalledWith();
    expect(hoisted.applyInvite).toHaveBeenCalledWith("ABC123", undefined);
  });

  it("leaves a not-yet-authenticated in-flight session to abandonInFlight alone", () => {
    hoisted.inFlight = true;
    joinFromChat("ABC123");
    expect(events).toEqual(["endSession", "abandonInFlight", "applyInvite"]);
  });
});

describe("E2: an invite link with the connect page not mounted", () => {
  it("on main it signs out for a server switch and does not apply it itself", async () => {
    await goToMain();
    joinFromChat("XYZ789", "h.example");

    expect(hoisted.clearAuth).toHaveBeenCalledWith("server_switch");
    expect(endSession).not.toHaveBeenCalled();
    expect(hoisted.deactivatePendingMessages).not.toHaveBeenCalled();
    // The logout navigation re-rendered connect, whose take-once closure
    // consumes the link; no hook was called directly.
    expect(hoisted.renderConnect).toHaveBeenCalledTimes(1);
    expect(hoisted.applyInvite).not.toHaveBeenCalled();
    const take = lastTakePendingInvite();
    expect(take()).toEqual({ code: "XYZ789", host: "h.example" });
    expect(take()).toBeNull();
  });

  it("on main the link stays pending until the connect page mounts", async () => {
    await goToMain();
    hoisted.clearAuth.mockImplementation(() => {
      events.push("clearAuth");
    });
    joinFromChat("XYZ789");
    expect(router.activePageId()).toBe("main");
    expect(hoisted.renderConnect).not.toHaveBeenCalled();

    router.navigate("connect");
    expect(lastTakePendingInvite()()).toEqual({ code: "XYZ789", host: undefined });
  });
});

describe("the in-chat invite chip", () => {
  it("goes straight in, with no dialog", () => {
    joinFromChat("ABC123", "h.example");
    expect(hoisted.confirmInviteJoin).not.toHaveBeenCalled();
    expect(hoisted.applyInvite).toHaveBeenCalledWith("ABC123", "h.example");
  });
});

describe("an invite link from outside the app", () => {
  it("runs at once when nothing is signed in or signing in", () => {
    invite("ABC123", "h.example");
    expect(hoisted.confirmInviteJoin).not.toHaveBeenCalled();
    expect(hoisted.applyInvite).toHaveBeenCalledTimes(1);
  });

  it("asks first while signed in, and joins only on confirm", async () => {
    setAuth("tok", USER, "Srv", "");
    invite("ABC123", "h.example");
    await vi.waitFor(() => expect(hoisted.confirmInviteJoin).toHaveBeenCalledTimes(1));

    const [body, onConfirm, opts] = hoisted.confirmInviteJoin.mock.calls[0] as [
      string,
      () => void,
      { title: string; confirmLabel: string },
    ];
    expect(body).toContain("Srv");
    expect(opts.title).toBe("Open invite for h.example?");
    // Asking changes nothing until the user confirms.
    expect(hoisted.applyInvite).not.toHaveBeenCalled();
    expect(endSession).not.toHaveBeenCalled();

    onConfirm();
    expect(hoisted.applyInvite).toHaveBeenCalledWith("ABC123", "h.example");
  });

  it("asks first while a session is in flight, with the no-host title and this-server wording", async () => {
    hoisted.inFlight = true;
    getConfig.mockReturnValueOnce({ host: "" });
    invite("ABC123");
    await vi.waitFor(() => expect(hoisted.confirmInviteJoin).toHaveBeenCalledTimes(1));
    const [body, , opts] = hoisted.confirmInviteJoin.mock.calls[0] as [
      string,
      () => void,
      { title: string },
    ];
    expect(body).toContain("this server");
    expect(opts.title).toBe("Open this invite?");
    expect(endSession).not.toHaveBeenCalled();
  });

  it("uses the in-call wording while in a voice channel", async () => {
    setAuth("tok", USER, "Srv", "");
    joinVoiceChannel(5);
    invite("ABC123");
    await vi.waitFor(() => expect(hoisted.confirmInviteJoin).toHaveBeenCalledTimes(1));
    const plain = hoisted.confirmInviteJoin.mock.calls[0]![0] as string;

    hoisted.confirmInviteJoin.mockClear();
    leaveVoiceChannel();
    invite("ABC123");
    await vi.waitFor(() => expect(hoisted.confirmInviteJoin).toHaveBeenCalledTimes(1));
    expect(plain).not.toBe(hoisted.confirmInviteJoin.mock.calls[0]![0]);
  });

  it("asks first on the main page even when the store says signed out", async () => {
    await goToMain();
    invite("ABC123");
    await vi.waitFor(() => expect(hoisted.confirmInviteJoin).toHaveBeenCalledTimes(1));
    expect(hoisted.clearAuth).not.toHaveBeenCalled();
  });

  it("logs a confirmation chunk that fails to load, and changes nothing", async () => {
    setAuth("tok", USER, "Srv", "");
    vi.doMock("@components/InviteJoinConfirm", () => {
      throw new Error("chunk 404");
    });
    try {
      invite("ABC123");
      await vi.waitFor(() =>
        expect(hoisted.warn).toHaveBeenCalledWith(
          "Invite confirmation failed to open",
          expect.any(Error),
        ),
      );
      expect(hoisted.confirmInviteJoin).not.toHaveBeenCalled();
      expect(hoisted.applyInvite).not.toHaveBeenCalled();
      expect(endSession).not.toHaveBeenCalled();
    } finally {
      vi.doMock("@components/InviteJoinConfirm", () => ({
        confirmInviteJoin: hoisted.confirmInviteJoin,
      }));
    }
  });

  it("logs a confirmation dialog that fails to open, and changes nothing", async () => {
    setAuth("tok", USER, "Srv", "");
    hoisted.confirmInviteJoin.mockImplementationOnce(() => {
      throw new Error("dialog failed");
    });
    invite("ABC123");
    await vi.waitFor(() =>
      expect(hoisted.warn).toHaveBeenCalledWith(
        "Invite confirmation failed to open",
        expect.any(Error),
      ),
    );
    expect(hoisted.applyInvite).not.toHaveBeenCalled();
  });
});
