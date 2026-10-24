// Behaviour suite for the `GlobalShortcuts` contract
// (`src/platform/contracts/globalShortcuts.ts`), added with U6. There is no
// legacy binding: nothing consumed this before. The renderer's reaction to a
// shortcut (toggling the live call's mute/deafen) is pinned by the MainPage
// tests that drive the same event.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { GlobalKeysStatus } from "../../../src/platform/contracts/globalShortcuts";

const portalStatus: GlobalKeysStatus = {
  backend: "portal",
  portalVersion: 2,
  triggers: { ptt: "F8", mute: "Ctrl+Alt+M", deafen: null },
  canConfigure: true,
  triggersUnnamed: false,
  sessionRefused: false,
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return undefined;
}
import type { GlobalShortcuts } from "../../../src/platform/contracts/globalShortcuts";

export interface NativeControl {
  /** The host or tray emits a voice shortcut. */
  emits(action: "mute" | "deafen"): Promise<void>;
  /** The commands the renderer invoked, in order. */
  commands(): string[];
  /** The key codes last handed to `voice_shortcuts_set_keys`, if any. */
  keyCodes(): { muteVk: number; deafenVk: number } | undefined;
  /** Whether the platform reports global key observation. */
  supported: boolean;
  /** The next answer of `global_keys_status`. */
  statusIs(payload: unknown): void;
  /** Make a command reject with `reason` (the host's bare error code). */
  rejects(command: string, reason: unknown): void;
  /** The arguments of the last call of `command`. */
  lastArgs(command: string): Record<string, unknown> | undefined;
  /** The host emits `global-keys-changed`. */
  emitsStatus(payload: unknown): Promise<void>;
  /** How many `global-keys-changed` listeners are registered right now. */
  statusListeners(): number;
}

export interface GlobalShortcutsSubject {
  readonly subject: GlobalShortcuts;
  readonly native: NativeControl;
}

export function describeGlobalShortcutsSuite(
  makeSubject: () => Promise<GlobalShortcutsSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("GlobalShortcuts", () => {
    let ctx: GlobalShortcutsSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("hands each action to the handler", async () => {
      const handler = vi.fn();
      ctx.subject.onShortcut(handler);
      await ctx.native.emits("mute");
      await ctx.native.emits("deafen");
      expect(handler.mock.calls).toEqual([["mute"], ["deafen"]]);
    });

    // Paired with a delivery first: "nothing arrives after unsubscribing" is
    // also what a subject that never delivers anything does.
    check("stops delivering once unsubscribed", async () => {
      const handler = vi.fn();
      const unsubscribe = ctx.subject.onShortcut(handler);
      await ctx.native.emits("mute");
      unsubscribe();
      await ctx.native.emits("deafen");
      expect(handler.mock.calls).toEqual([["mute"]]);
    });

    check("delivers a known action even after an unrecognised one", async () => {
      const handler = vi.fn();
      ctx.subject.onShortcut(handler);
      await ctx.native.emits("not-a-shortcut" as "mute");
      await ctx.native.emits("mute");
      expect(handler.mock.calls).toEqual([["mute"]]);
    });

    check("starts the native poller", async () => {
      await ctx.subject.start();
      expect(ctx.native.commands()).toContain("voice_shortcuts_start");
    });

    check("hands a rebound combination to the native poller", async () => {
      await ctx.subject.setKeys({ muteVk: 0x4b, deafenVk: 0x71 });
      expect(ctx.native.commands()).toContain("voice_shortcuts_set_keys");
      expect(ctx.native.keyCodes()).toEqual({ muteVk: 0x4b, deafenVk: 0x71 });
    });

    check("status reports the backend and the bound triggers", async () => {
      ctx.native.statusIs(portalStatus);
      expect(await ctx.subject.status()).toEqual(portalStatus);
    });

    check("status maps a rejected invoke to backend none", async () => {
      ctx.native.rejects("global_keys_status", "boom");
      expect(await ctx.subject.status()).toEqual({
        backend: "none",
        portalVersion: 0,
        triggers: { ptt: null, mute: null, deafen: null },
        canConfigure: false,
        triggersUnnamed: false,
        sessionRefused: false,
      });
    });

    check("status reads a payload it cannot parse as backend none", async () => {
      ctx.native.statusIs({ backend: "carrier-pigeon" });
      expect((await ctx.subject.status()).backend).toBe("none");
    });

    check("status reads an empty trigger as unbound", async () => {
      ctx.native.statusIs({ ...portalStatus, triggers: { ptt: "", mute: "x", deafen: null } });
      expect((await ctx.subject.status()).triggers).toEqual({ ptt: null, mute: "x", deafen: null });
    });

    check("status carries the unnamed-triggers and refused-session flags", async () => {
      ctx.native.statusIs({ ...portalStatus, triggersUnnamed: true, sessionRefused: true });
      const flagged = await ctx.subject.status();
      expect(flagged.triggersUnnamed).toBe(true);
      expect(flagged.sessionRefused).toBe(true);
      ctx.native.statusIs({ ...portalStatus, triggersUnnamed: "yes", sessionRefused: 1 });
      const loose = await ctx.subject.status();
      expect(loose.triggersUnnamed).toBe(false);
      expect(loose.sessionRefused).toBe(false);
      ctx.native.statusIs({ backend: "portal", portalVersion: 1, triggers: {} });
      expect((await ctx.subject.status()).triggersUnnamed).toBe(false);
    });

    check("bindPortal hands the suggested keys to the host and returns its status", async () => {
      ctx.native.statusIs(portalStatus);
      const status = await ctx.subject.bindPortal({ pttVk: 0x77, muteVk: 0x4d, deafenVk: 0x44 });
      expect(ctx.native.lastArgs("global_keys_portal_bind")).toEqual({
        pttVk: 0x77,
        muteVk: 0x4d,
        deafenVk: 0x44,
      });
      expect(status).toEqual(portalStatus);
    });

    check("bindPortal surfaces bind_in_progress as a typed error", async () => {
      ctx.native.rejects("global_keys_portal_bind", "bind_in_progress");
      const err = await rejection(ctx.subject.bindPortal({ pttVk: 0, muteVk: 1, deafenVk: 2 }));
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe("bind_in_progress");
    });

    check("bindPortal reports a cancelled dialog and an unknown failure by code", async () => {
      ctx.native.rejects("global_keys_portal_bind", "bind_cancelled");
      const cancelled = await rejection(
        ctx.subject.bindPortal({ pttVk: 0, muteVk: 1, deafenVk: 2 }),
      );
      expect((cancelled as { code?: string }).code).toBe("bind_cancelled");
      ctx.native.rejects("global_keys_portal_bind", new Error("ipc down"));
      const unknown = await rejection(ctx.subject.bindPortal({ pttVk: 0, muteVk: 1, deafenVk: 2 }));
      expect((unknown as { code?: string }).code).toBe("unknown");
    });

    check("configurePortal opens the desktop settings or rejects with a code", async () => {
      await ctx.subject.configurePortal();
      expect(ctx.native.commands()).toContain("global_keys_portal_configure");
      ctx.native.rejects("global_keys_portal_configure", "unsupported");
      const err = await rejection(ctx.subject.configurePortal());
      expect((err as { code?: string }).code).toBe("unsupported");
    });

    check("onStatusChange delivers a changed status and stops once unsubscribed", async () => {
      const handler = vi.fn();
      const unsubscribe = ctx.subject.onStatusChange(handler);
      await ctx.native.emitsStatus(portalStatus);
      unsubscribe();
      await ctx.native.emitsStatus({
        ...portalStatus,
        triggers: { ptt: null, mute: null, deafen: null },
      });
      expect(handler.mock.calls).toEqual([[portalStatus]]);
      expect(ctx.native.statusListeners()).toBe(0);
    });

    check("onStatusChange unsubscribed before the listener is ready still unlistens", async () => {
      ctx.subject.onStatusChange(vi.fn())();
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(ctx.native.statusListeners()).toBe(0);
    });
  });
}
