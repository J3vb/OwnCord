// Behaviour suite for the `GlobalShortcuts` contract
// (`src/platform/contracts/globalShortcuts.ts`), added with U6. There is no
// legacy binding: nothing consumed this before. The renderer's reaction to a
// shortcut (toggling the live call's mute/deafen) is pinned by the MainPage
// tests that drive the same event.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { GlobalShortcuts } from "../../../src/platform/contracts/globalShortcuts";

export interface NativeControl {
  /** The host or tray emits a voice shortcut. */
  emits(action: "mute" | "deafen"): Promise<void>;
  /** The commands the renderer invoked, in order. */
  commands(): string[];
  /** Whether the platform reports global key observation. */
  supported: boolean;
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
  });
}
