/**
 * Stream preview — hover/focus to see a live video preview of a remote
 * participant's camera or screenshare in the voice channel sidebar.
 *
 * Lifecycle:
 *   mouseenter/focusin → 300ms debounce → create <video> or placeholder
 *   mouseleave/focusout/scroll → animate collapse → remove DOM → cleanup
 *
 * All timers and listeners are cleaned up via AbortSignal on sidebar teardown.
 */

import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { getRemoteVideoStream } from "@lib/livekitSession";
import { voiceStore } from "@stores/voice.store";

/** Internal state tracked per voice-user-item row for cleanup. */
interface PreviewState {
  readonly debounce: number;
  animation: number;
  trackCleanup: (() => void) | null;
}

const previewTimers = new WeakMap<HTMLElement, PreviewState>();

/** Height the preview expands to. Set dynamically after DOM insertion. */
/** Debounce delay before showing the preview. */
const DEBOUNCE_MS = 300;

function clearPreviewState(row: HTMLElement): void {
  const state = previewTimers.get(row);
  if (state === undefined) return;
  clearTimeout(state.debounce);
  clearTimeout(state.animation);
  if (state.trackCleanup !== null) state.trackCleanup();
  previewTimers.delete(row);
}

function removePreviewDom(row: HTMLElement): void {
  // Preview is inserted as sibling after the row, not inside it
  const existing = row.nextElementSibling;
  if (existing !== null && existing.classList.contains("vu-preview")) {
    const video = existing.querySelector("video");
    if (video !== null) video.srcObject = null;
    existing.remove();
  }
}

function showPreview(
  row: HTMLElement,
  userId: number,
  username: string,
  hasScreenshare: boolean,
  hasCamera: boolean,
  onClickJoin?: () => void,
  onClickWatch?: () => void,
): void {
  if (!document.contains(row)) return;

  // Try screenshare first, then camera
  let stream: MediaStream | null = null;
  let isScreen = false;
  if (hasScreenshare) {
    stream = getRemoteVideoStream(userId, "screenshare");
    if (stream !== null) isScreen = true;
  }
  if (stream === null && hasCamera) {
    stream = getRemoteVideoStream(userId, "camera");
    isScreen = false;
  }

  const previewDiv = createElement("div", { class: "vu-preview" });

  if (stream !== null) {
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.className = isScreen ? "preview-screen" : "preview-camera";
    video.setAttribute("aria-label", `Stream preview for ${username}`);
    video.srcObject = stream;

    // Handle autoplay failure — swap to placeholder
    video.play().catch(() => {
      if (!document.contains(row)) return;
      video.srcObject = null;
      previewDiv.textContent = "";
      previewDiv.appendChild(createPlaceholder(onClickJoin));
    });

    // Track renegotiation: detect ended/mute and swap to placeholder
    const track = stream.getVideoTracks()[0];
    if (track !== undefined) {
      const onTrackDead = (): void => {
        if (!document.contains(row)) return;
        video.srcObject = null;
        previewDiv.textContent = "";
        previewDiv.appendChild(createPlaceholder(onClickJoin));
      };
      track.addEventListener("ended", onTrackDead);
      track.addEventListener("mute", onTrackDead);

      // Store cleanup function
      const state = previewTimers.get(row);
      if (state !== undefined) {
        state.trackCleanup = () => {
          track.removeEventListener("ended", onTrackDead);
          track.removeEventListener("mute", onTrackDead);
        };
      }
    }

    video.style.cursor = "pointer";
    if (onClickWatch !== undefined) {
      video.addEventListener("click", (e) => {
        e.stopPropagation();
        onClickWatch();
      });
    }
    previewDiv.appendChild(video);
  } else {
    const isInChannel = voiceStore.getState().currentChannelId !== null;
    if (isInChannel) {
      previewDiv.appendChild(createUnavailablePlaceholder(onClickWatch));
    } else {
      previewDiv.appendChild(createPlaceholder(onClickJoin));
    }
  }

  // Screen reader announcement
  const announcement = createElement(
    "span",
    {
      role: "status",
      "aria-live": "polite",
      class: "sr-only",
    },
    `Showing stream preview for ${username}`,
  );
  previewDiv.appendChild(announcement);

  // Close when mouse leaves the preview div (but not if moving back to row)
  previewDiv.addEventListener("mouseleave", () => {
    if (row.matches(":hover")) return; // Moving back to row — keep open
    hidePreview(row);
  });

  // Insert as sibling after the row (not inside it — row is display:flex)
  row.after(previewDiv);

  // Animate open — measure actual content height
  requestAnimationFrame(() => {
    if (!document.contains(previewDiv)) return;
    previewDiv.style.height = `${previewDiv.scrollHeight}px`;
  });
}

function createPlaceholder(onClickJoin?: () => void): HTMLElement {
  const placeholder = createElement("div", {
    class: "vu-preview-placeholder",
    role: "button",
    "aria-label": "Join channel to preview stream",
  });
  const icon = createIcon("monitor", 14);
  icon.style.color = "var(--text-faint)";
  placeholder.appendChild(icon);
  const text = createElement("span", {}, "Join to preview");
  placeholder.appendChild(text);
  if (onClickJoin !== undefined) {
    placeholder.addEventListener("click", (e) => {
      e.stopPropagation();
      onClickJoin();
    });
  }
  return placeholder;
}

function createUnavailablePlaceholder(onClickWatch?: () => void): HTMLElement {
  const placeholder = createElement("div", {
    class: "vu-preview-placeholder",
    role: "button",
    "aria-label": "Stream unavailable",
  });
  const icon = createIcon("monitor-off", 14);
  icon.style.color = "var(--text-faint)";
  placeholder.appendChild(icon);
  const text = createElement("span", {}, "Stream unavailable");
  placeholder.appendChild(text);
  if (onClickWatch !== undefined) {
    placeholder.addEventListener("click", (e) => {
      e.stopPropagation();
      onClickWatch();
    });
  }
  return placeholder;
}

function hidePreview(row: HTMLElement): void {
  const state = previewTimers.get(row);
  if (state !== undefined) {
    clearTimeout(state.debounce);
    if (state.trackCleanup !== null) {
      state.trackCleanup();
      state.trackCleanup = null;
    }
  }

  // Preview is a sibling after the row
  const next = row.nextElementSibling;
  const previewDiv =
    next !== null && next.classList.contains("vu-preview") ? (next as HTMLElement) : null;
  if (previewDiv === null) {
    previewTimers.delete(row);
    return;
  }

  // Animate close
  previewDiv.style.height = "0";
  const animTimer = window.setTimeout(() => {
    removePreviewDom(row);
    previewTimers.delete(row);
  }, 200);

  if (state !== undefined) {
    state.animation = animTimer;
  }
}

/**
 * Attach stream preview behavior to a voice-user-item row.
 * Call once per row during render. Cleanup is automatic via the AbortSignal.
 */
export function attachStreamPreview(
  row: HTMLElement,
  userId: number,
  username: string,
  hasScreenshare: boolean,
  hasCamera: boolean,
  signal: AbortSignal,
  onClickJoin?: () => void,
  onClickWatch?: () => void,
): void {
  const startPreview = (): void => {
    clearPreviewState(row);
    removePreviewDom(row);

    const debounceTimer = window.setTimeout(() => {
      showPreview(row, userId, username, hasScreenshare, hasCamera, onClickJoin, onClickWatch);
    }, DEBOUNCE_MS);

    previewTimers.set(row, {
      debounce: debounceTimer,
      animation: 0,
      trackCleanup: null,
    });
  };

  const stopPreview = (): void => {
    hidePreview(row);
  };

  // Delayed stop — gives the user time to move mouse to the preview div
  const stopPreviewDelayed = (): void => {
    const state = previewTimers.get(row);
    if (state !== undefined) {
      clearTimeout(state.animation);
      state.animation = window.setTimeout(() => {
        // Check if mouse is now over the preview sibling
        const preview = row.nextElementSibling;
        if (
          preview !== null &&
          preview.classList.contains("vu-preview") &&
          preview.matches(":hover")
        ) {
          return; // Mouse moved to preview — keep it open
        }
        hidePreview(row);
      }, 150);
    } else {
      hidePreview(row);
    }
  };

  // Mouse handlers
  row.addEventListener("mouseenter", startPreview, { signal });
  row.addEventListener("mouseleave", stopPreviewDelayed, { signal });

  // Keyboard accessibility: focus mirrors hover
  row.addEventListener("focusin", startPreview, { signal });
  row.addEventListener("focusout", stopPreview, { signal });

  // Cleanup on abort (sidebar teardown)
  signal.addEventListener("abort", () => {
    clearPreviewState(row);
    removePreviewDom(row);
  });
}

/**
 * Attach scroll listener to a voice-users-list container to collapse
 * any open previews when the user scrolls. WebView2 doesn't always
 * fire mouseleave on scroll.
 */
export function attachScrollCollapse(container: HTMLElement, signal: AbortSignal): void {
  container.addEventListener(
    "scroll",
    () => {
      const openPreviews = container.querySelectorAll<HTMLElement>(".vu-preview");
      for (const preview of openPreviews) {
        // Preview is a sibling after the row — get the preceding voice-user-item
        const row = preview.previousElementSibling;
        if (row !== null && row.classList.contains("voice-user-item")) {
          hidePreview(row as HTMLElement);
        }
      }
    },
    { signal, passive: true },
  );
}
