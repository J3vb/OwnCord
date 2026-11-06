/** The voice widget's listen-only affordance: a "Grant Microphone" button and its persistent explanation. */
import { createElement, setText } from "@lib/dom";
import { retryMicPermission } from "@lib/voice/livekitSession";
import { voiceStore } from "@stores/voice.store";
import { voiceText as t } from "../../../i18n/voice";

export interface ListenOnlyUi {
  readonly grantBtn: HTMLButtonElement;
  readonly noticeEl: HTMLDivElement;
  /** Show or hide the button and fill the notice for the current state. */
  sync(listenOnly: boolean): void;
  /** Stop reacting to a retry that finishes after the widget is gone. */
  dispose(): void;
}

/** `onRetried` redraws the widget once a retry settles. */
export function createListenOnlyUi(signal: AbortSignal, onRetried: () => void): ListenOnlyUi {
  /**
   * Whether the user has retried the microphone in this session and it is
   * still unavailable. The widget cannot see *why* the OS refused (the
   * notifier contract is a boolean), but it can honestly report the outcome
   * of its own retry — so the guidance stops promising a grant that the retry
   * just failed to obtain.
   */
  let micRetryFailed = false;
  let live = true;

  const grantBtn = createElement(
    "button",
    {
      class: "vw-grant-mic",
      "aria-label": t("widget.grantMicLabel"),
    },
    t("widget.grantMic"),
  );
  grantBtn.style.display = "none";
  grantBtn.addEventListener(
    "click",
    () => {
      grantBtn.disabled = true;
      setText(grantBtn, t("widget.requesting"));
      void retryMicPermission().finally(() => {
        // The retry swallowed its own error and only reports via store state,
        // so read the state it left: still listen-only means the attempt did
        // not acquire the mic, and the persistent notice should stop
        // implying a permission grant is all that stands in the way.
        micRetryFailed = voiceStore.getState().listenOnly;
        if (!live) return;
        setText(grantBtn, t("widget.grantMic"));
        // Delegate the disabled/title state back to the widget's render, which
        // re-runs its freeze logic — the single authority for the socket-down
        // freeze. Hardcoding `disabled = false` here would silently re-enable
        // this button (and drop its stale title) even while the WS socket is
        // still down and every sibling control remains frozen.
        onRetried();
      });
    },
    { signal },
  );

  // A persistent line beside the button: it is hidden while nothing is wrong,
  // but in listen-only mode the state needs a reason and a next step.
  const noticeEl = createElement("div", {
    // No `setting-desc`: its margin/font would apply even while this live
    // region is empty (it stays rendered but empty outside listen-only mode
    // so a screen reader hears it fill, not appear filled), adding a stray
    // gap to every voice session. `.vw-mic-notice` owns its own type.
    class: "vw-mic-notice",
    "data-testid": "vw-mic-notice",
    role: "status",
    "aria-live": "polite",
  });

  function sync(listenOnly: boolean): void {
    // Leaving listen-only clears the "retry failed" memory, so a later join
    // that lands here again starts from the helpful hint rather than a stale
    // claim about the permission.
    if (!listenOnly) micRetryFailed = false;
    grantBtn.style.display = listenOnly ? "block" : "none";
    // How to change the state, and, once a retry has failed, that it is the
    // system permission, not this app, that has to change. The wording never
    // claims the mic is denied when the real cause (no device, in use by
    // another app) is something a permission grant cannot fix.
    const text = !listenOnly
      ? ""
      : micRetryFailed
        ? t("widget.listenOnlyBlocked")
        : t("widget.listenOnlyHint");
    // Set only on change: render runs on unrelated store updates, and a
    // screen reader can re-read a replaced text node even when identical,
    // which would break the "announced once" goal.
    if (noticeEl.textContent !== text) setText(noticeEl, text);
  }

  return {
    grantBtn,
    noticeEl,
    sync,
    dispose: () => {
      live = false;
    },
  };
}
