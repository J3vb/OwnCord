/**
 * Step 6.53 — Soundboard component.
 * Grid of sound buttons with cooldown enforcement (1 play per 3s).
 */

import { createElement, appendChildren, setText, clearChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SoundItem {
  readonly id: number;
  readonly name: string;
  readonly durationMs: number;
}

export interface SoundboardOptions {
  readonly sounds: readonly SoundItem[];
  readonly onPlaySound: (soundId: number) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COOLDOWN_MS = 3_000;

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSoundboard(options: SoundboardOptions): MountableComponent {
  let root: HTMLDivElement | null = null;
  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  const ac = new AbortController();

  function mount(container: Element): void {
    root = createElement("div", { class: "soundboard" });

    if (options.sounds.length === 0) {
      const empty = createElement(
        "div",
        { class: "soundboard__empty" },
        "No sounds available",
      );
      root.appendChild(empty);
      container.appendChild(root);
      return;
    }

    const grid = createElement("div", { class: "soundboard__grid" });
    const buttons: HTMLButtonElement[] = [];

    for (const sound of options.sounds) {
      const btn = createElement("button", { class: "sound-btn", type: "button" });
      const nameSpan = createElement("span", { class: "sound-btn__name" }, sound.name);
      const durSpan = createElement(
        "span",
        { class: "sound-btn__duration" },
        formatDuration(sound.durationMs),
      );

      appendChildren(btn, nameSpan, durSpan);

      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        options.onPlaySound(sound.id);
        startCooldown(buttons);
      }, { signal: ac.signal });

      buttons.push(btn);
      grid.appendChild(btn);
    }

    root.appendChild(grid);
    container.appendChild(root);
  }

  function startCooldown(buttons: readonly HTMLButtonElement[]): void {
    for (const btn of buttons) {
      btn.disabled = true;
      btn.classList.add("sound-btn--cooldown");
    }

    if (cooldownTimer !== null) {
      clearTimeout(cooldownTimer);
    }

    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      for (const btn of buttons) {
        btn.disabled = false;
        btn.classList.remove("sound-btn--cooldown");
      }
    }, COOLDOWN_MS);
  }

  function destroy(): void {
    ac.abort();
    if (cooldownTimer !== null) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }
    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy };
}
