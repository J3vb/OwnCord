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

    // Remove existing cell for this user first
    if (cells.has(userId)) {
      removeStream(userId);
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
      "data-userId": String(userId),
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
