/**
 * VideoGrid component — renders remote video streams in a responsive CSS grid.
 * Replaces the chat area when cameras are active.
 */

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";

export interface VideoGridComponent extends MountableComponent {
  addStream(userId: number, username: string, stream: MediaStream): void;
  removeStream(userId: number): void;
  hasStreams(): boolean;
}

function computeGridColumns(count: number): string {
  if (count <= 1) return "1fr";
  if (count <= 4) return "1fr 1fr";
  if (count <= 9) return "1fr 1fr 1fr";
  return "1fr 1fr 1fr 1fr";
}

export function createVideoGrid(): VideoGridComponent {
  let root: HTMLDivElement | null = null;
  const cells = new Map<number, HTMLDivElement>();

  function updateLayout(): void {
    if (root === null) return;
    root.style.gridTemplateColumns = computeGridColumns(cells.size);
  }

  function addStream(userId: number, username: string, stream: MediaStream): void {
    if (root === null) return;

    // If a cell already exists for this user, update it in place
    const existing = cells.get(userId);
    if (existing) {
      const video = existing.querySelector("video");
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
      const label = existing.querySelector(".video-username");
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

    cells.set(userId, cell);
    root.appendChild(cell);
    updateLayout();
  }

  function removeStream(userId: number): void {
    const cell = cells.get(userId);
    if (cell === undefined) return;

    const video = cell.querySelector("video");
    if (video !== null) {
      video.srcObject = null;
    }

    cell.remove();
    cells.delete(userId);
    updateLayout();
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
    for (const [, cell] of cells) {
      const video = cell.querySelector("video");
      if (video !== null) {
        video.srcObject = null;
      }
    }
    cells.clear();

    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy, addStream, removeStream, hasStreams };
}
