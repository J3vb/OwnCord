/**
 * VideoGrid component — renders remote video streams in a responsive CSS grid.
 * Replaces the chat area when cameras are active.
 */

import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { muteScreenshareAudio, setUserVolume } from "@lib/livekitSession";
import type { MountableComponent } from "@lib/safe-render";

export interface TileConfig {
  /** True if this is the local user's own tile (no audio controls) */
  readonly isSelf: boolean;
  /** The real userId for audio control (differs from tile ID for screenshare tiles) */
  readonly audioUserId: number;
  /** True if this tile represents a screenshare (vs camera) */
  readonly isScreenshare: boolean;
}

export interface VideoGridComponent extends MountableComponent {
  addStream(userId: number, username: string, stream: MediaStream, config?: TileConfig): void;
  removeStream(userId: number): void;
  hasStreams(): boolean;
  setFocusedTile(tileId: number): void;
  getFocusedTileId(): number | null;
}

/** Create a fresh volume icon element. */
function volumeIcon(): SVGSVGElement { return createIcon("volume-2", 16); }
/** Create a fresh volume-x (muted) icon element. */
function volumeXIcon(): SVGSVGElement { return createIcon("volume-x", 16); }
/** Replace a button's icon child with a new one. */
function setButtonIcon(btn: HTMLButtonElement, icon: SVGSVGElement): void {
  while (btn.firstChild) btn.removeChild(btn.firstChild);
  btn.appendChild(icon);
}

function computeGridColumns(count: number): string {
  if (count <= 1) return "1fr";
  if (count <= 4) return "1fr 1fr";
  if (count <= 9) return "1fr 1fr 1fr";
  return "1fr 1fr 1fr 1fr";
}

export function createVideoGrid(): VideoGridComponent {
  let root: HTMLDivElement | null = null;
  const cells = new Map<number, { el: HTMLDivElement; config?: TileConfig }>();
  let focusedTileId: number | null = null;

  function rebuildFocusLayout(): void {
    if (root === null) return;

    // Clear root children (we'll re-append in focus layout order)
    while (root.firstChild) root.removeChild(root.firstChild);

    if (focusedTileId === null || cells.size === 0) {
      // No focus — use regular grid layout
      root.classList.remove("focus-mode");
      root.style.gridTemplateColumns = computeGridColumns(cells.size);
      for (const entry of cells.values()) {
        entry.el.classList.remove("focused", "thumb");
        root.appendChild(entry.el);
      }
      return;
    }

    root.classList.add("focus-mode");
    root.style.gridTemplateColumns = "";  // Clear grid columns, focus uses flex

    // Main area
    const mainArea = createElement("div", { class: "video-focus-main" });
    // Strip area
    const stripArea = createElement("div", { class: "video-focus-strip" });

    const focusedEntry = cells.get(focusedTileId);
    if (focusedEntry !== undefined) {
      focusedEntry.el.classList.add("focused");
      focusedEntry.el.classList.remove("thumb");
      mainArea.appendChild(focusedEntry.el);
    }

    for (const [id, entry] of cells) {
      if (id === focusedTileId) continue;
      entry.el.classList.remove("focused");
      entry.el.classList.add("thumb");
      stripArea.appendChild(entry.el);
    }

    root.appendChild(mainArea);
    // Only show strip if there are thumbnails
    if (stripArea.childElementCount > 0) {
      root.appendChild(stripArea);
    }
  }

  function setFocusedTile(tileId: number): void {
    focusedTileId = tileId;
    rebuildFocusLayout();
  }

  function getFocusedTileIdFn(): number | null {
    return focusedTileId;
  }

  function updateLayout(): void {
    if (root === null) return;
    if (focusedTileId !== null) {
      rebuildFocusLayout();
      return;
    }
    root.style.gridTemplateColumns = computeGridColumns(cells.size);
  }

  function addStream(userId: number, username: string, stream: MediaStream, config?: TileConfig): void {
    if (root === null) return;

    // If a cell already exists for this user, update it in place
    const existing = cells.get(userId);
    if (existing !== undefined) {
      const video = existing.el.querySelector("video");
      if (video !== null) {
        // Only replace srcObject if the underlying tracks changed
        const oldTracks = (video.srcObject as MediaStream | null)?.getTracks() ?? [];
        const newTracks = stream.getTracks();
        const tracksMatch =
          oldTracks.length === newTracks.length &&
          oldTracks.every((t, i) => t.id === newTracks[i]?.id);
        if (!tracksMatch) {
          video.srcObject = stream;
        }
      }
      // Update username label in case it changed
      const label = existing.el.querySelector(".video-username");
      if (label !== null) {
        label.textContent = username;
      }
      return;
    }

    const video = createElement("video", {
      autoplay: "",
      playsinline: "",
    });
    video.muted = true;
    video.srcObject = stream;

    const label = createElement("div", { class: "video-username" }, username);

    const cell = createElement("div", {
      class: "video-cell",
      "data-user-id": String(userId),
    });
    appendChildren(cell, video, label);

    cell.addEventListener("click", (e) => {
      // Don't switch focus if clicking the mute button
      if ((e.target as Element).closest(".tile-mute-btn")) return;
      if (focusedTileId !== null && focusedTileId !== userId) {
        focusedTileId = userId;
        rebuildFocusLayout();
      }
    });

    // Add audio control overlay for remote tiles
    if (config !== undefined && !config.isSelf) {
      let muted = false;
      let currentVolume = 100;

      const overlay = createElement("div", { class: "video-tile-overlay" });

      // Volume slider
      const volumeSlider = createElement("input", {
        type: "range",
        min: "0",
        max: "200",
        value: "100",
        class: "tile-volume-slider",
        "aria-label": "Volume",
      }) as HTMLInputElement;

      volumeSlider.addEventListener("input", () => {
        currentVolume = Number(volumeSlider.value);
        const wasMuted = muted;
        muted = currentVolume === 0;
        if (config.isScreenshare) {
          muteScreenshareAudio(config.audioUserId, muted);
        } else {
          setUserVolume(config.audioUserId, currentVolume);
        }
        setButtonIcon(muteBtn, muted ? volumeXIcon() : volumeIcon());
        muteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
        if (muted !== wasMuted) {
          overlay.classList.toggle("muted", muted);
        }
      });

      // Mute button
      const muteBtn = createElement("button", {
        class: "tile-mute-btn",
        "aria-label": "Mute",
      }) as HTMLButtonElement;
      muteBtn.appendChild(volumeIcon());

      muteBtn.addEventListener("click", () => {
        muted = !muted;
        if (muted) {
          if (config.isScreenshare) {
            muteScreenshareAudio(config.audioUserId, true);
          } else {
            setUserVolume(config.audioUserId, 0);
          }
          volumeSlider.value = "0";
        } else {
          if (currentVolume === 0) currentVolume = 100;
          if (config.isScreenshare) {
            muteScreenshareAudio(config.audioUserId, false);
          } else {
            setUserVolume(config.audioUserId, currentVolume);
          }
          volumeSlider.value = String(currentVolume);
        }
        setButtonIcon(muteBtn, muted ? volumeXIcon() : volumeIcon());
        muteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
        overlay.classList.toggle("muted", muted);
      });

      overlay.appendChild(volumeSlider);
      overlay.appendChild(muteBtn);
      cell.appendChild(overlay);
    }

    cells.set(userId, { el: cell, config });
    root.appendChild(cell);
    if (focusedTileId !== null) {
      rebuildFocusLayout();
    } else {
      updateLayout();
    }
  }

  function removeStream(userId: number): void {
    const entry = cells.get(userId);
    if (entry === undefined) return;

    const video = entry.el.querySelector("video");
    if (video !== null) video.srcObject = null;

    entry.el.remove();
    cells.delete(userId);

    // If focused tile was removed, focus the first remaining tile or clear
    const wasFocusMode = focusedTileId !== null;
    if (focusedTileId === userId) {
      const firstKey = cells.keys().next().value;
      focusedTileId = firstKey ?? null;
    }

    if (focusedTileId !== null || wasFocusMode) {
      rebuildFocusLayout();
    } else {
      updateLayout();
    }
  }

  function hasStreams(): boolean {
    return cells.size > 0;
  }

  function mount(container: Element): void {
    root = createElement("div", {
      class: "video-grid",
      "data-testid": "video-grid",
    });
    container.appendChild(root);
  }

  function destroy(): void {
    for (const [, entry] of cells) {
      const video = entry.el.querySelector("video");
      if (video !== null) video.srcObject = null;
    }
    cells.clear();
    focusedTileId = null;

    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy, addStream, removeStream, hasStreams, setFocusedTile, getFocusedTileId: getFocusedTileIdFn };
}
