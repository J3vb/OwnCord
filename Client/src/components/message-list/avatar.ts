/**
 * The one place that answers "how do I draw this user".
 *
 * Before phase 6 there were four answers: message rows, the reply preview, the
 * member list and the user bar each built a coloured `<div>` with a letter in
 * it, while `UserProfilePopup` alone knew how to render an actual image. Now
 * that avatars can be uploaded, every one of those surfaces has to be able to
 * show a picture — and the letter has to remain the fallback, because most
 * users will never upload one.
 *
 * Two rules the helper exists to enforce:
 *
 *  - The image is fetched, not linked. `/api/v1/files/{id}` is authenticated,
 *    and `<img src>` cannot carry an Authorization header, so assigning the
 *    server URL directly would 401. Bytes go through the same cert-pinned,
 *    bearer-token, cached path attachments and custom emoji use, and are
 *    swapped in as a data: URI once they arrive.
 *  - The letter is what renders until (and if) the bytes arrive. An avatar that
 *    fails to load leaves a normal-looking row rather than a broken image.
 *
 * The pure name/letter helpers stay in `@lib/avatar`; this module owns the DOM
 * and the fetch, so it lives beside the attachments helper it needs.
 */

import { createElement } from "@lib/dom";
import { avatarInitial, resolveDisplayName, type AvatarSubject } from "@lib/avatar";
import {
  fetchImageAsObjectUrl,
  isSafeUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "./attachments";

export interface AvatarOptions {
  /** Class applied to the wrapper — each surface keeps its own sizing rules. */
  readonly className: string;
  /** CSS background for the letter fallback (usually the user's role color). */
  readonly background?: string;
  /** Extra attributes for the wrapper (data-testid, title, …). */
  readonly attrs?: Record<string, string>;
  /** The row beside it already names the person: the picture gets alt="". */
  readonly decorative?: boolean;
  /**
   * Start the image fetch only once the wrapper nears the viewport, and run it
   * through a shared limiter. For long lists (the member list) where one fetch
   * per row on every rebuild would flood the network. Off by default.
   */
  readonly deferUntilVisible?: boolean;
}

/** Fetches in flight at once for `deferUntilVisible` avatars. */
const MAX_CONCURRENT_AVATAR_FETCHES = 6;
/** How far outside the viewport a row starts loading, so scrolling rarely
 *  shows a letter that is about to become a picture. */
const VISIBILITY_ROOT_MARGIN = "200px";

let activeFetches = 0;
const fetchQueue: Array<() => Promise<unknown>> = [];

function pumpFetchQueue(): void {
  while (activeFetches < MAX_CONCURRENT_AVATAR_FETCHES) {
    const job = fetchQueue.shift();
    if (job === undefined) return;
    activeFetches++;
    const release = (): void => {
      activeFetches--;
      pumpFetchQueue();
    };
    job().then(release, release);
  }
}

/** Run `job` once fewer than MAX_CONCURRENT_AVATAR_FETCHES are in flight. */
function enqueueFetch(job: () => Promise<unknown>): void {
  fetchQueue.push(job);
  pumpFetchQueue();
}

const visibilityCallbacks = new Map<Element, () => void>();
let visibilityObserver: IntersectionObserver | null = null;

function onVisibility(entries: IntersectionObserverEntry[]): void {
  const observer = visibilityObserver;
  if (observer === null) return;
  for (const entry of entries) {
    const start = visibilityCallbacks.get(entry.target);
    if (start === undefined) continue;
    if (!entry.target.isConnected) {
      visibilityCallbacks.delete(entry.target);
      observer.unobserve(entry.target);
    } else if (entry.isIntersecting) {
      visibilityCallbacks.delete(entry.target);
      observer.unobserve(entry.target);
      start();
    }
  }
  // A row removed while off-screen never reports again; drop it here so the
  // observer does not pin the detached tree.
  for (const target of visibilityCallbacks.keys()) {
    if (!target.isConnected) {
      visibilityCallbacks.delete(target);
      observer.unobserve(target);
    }
  }
}

/** Call `start` once, when `target` is first near the viewport. Without
 *  IntersectionObserver (jsdom, old webviews) it runs right away, after a
 *  microtask so the caller has attached the element first. */
function whenVisible(target: Element, start: () => void): void {
  if (typeof IntersectionObserver === "undefined") {
    queueMicrotask(start);
    return;
  }
  visibilityObserver ??= new IntersectionObserver(onVisibility, {
    rootMargin: VISIBILITY_ROOT_MARGIN,
  });
  visibilityCallbacks.set(target, start);
  visibilityObserver.observe(target);
}

/**
 * Whether `url` is something worth trying to load as an avatar. Empty, absent
 * and non-http(s) values all fall back to the letter rather than producing an
 * `<img>` that can only fail.
 *
 * The shape check comes first and is deliberate: `resolveServerUrl` prefixes
 * anything that does not already start with a scheme, so a bare
 * `javascript:alert(1)` would come back as `https://host` + that string and
 * sail through `isSafeUrl`. Only a server-relative path or an already-absolute
 * http(s) URL is a candidate.
 */
export function isRenderableAvatar(url: string | null | undefined): url is string {
  if (typeof url !== "string" || url.length === 0) return false;
  const absolute = url.startsWith("http://") || url.startsWith("https://");
  if (!absolute && !url.startsWith("/")) return false;
  return isSafeUrl(resolveServerUrl(url));
}

const AVATAR_COLORS = ["#5865f2", "#57f287", "#fee75c", "#eb459e", "#ed4245"];

/** The letter fallback's background: one of five colours, stable per
 *  username, so the member list, chat, voice roster and call view agree. */
export function pickAvatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] ?? "#5865f2";
}

/**
 * Build an avatar element: the letter fallback immediately, the image swapped
 * in asynchronously when there is one to fetch.
 *
 * The returned element is usable synchronously — callers append it and move on.
 */
export function createAvatarElement(
  subject: AvatarSubject,
  options: AvatarOptions,
): HTMLDivElement {
  const wrapper = createElement("div", {
    class: options.className,
    ...options.attrs,
  });
  if (options.background !== undefined) {
    wrapper.style.background = options.background;
  }

  const letter = createElement("span", { class: "avatar-initial" }, avatarInitial(subject));
  wrapper.appendChild(letter);

  if (subject.isDeleted === true || !isRenderableAvatar(subject.avatar)) {
    return wrapper;
  }

  const resolved = resolveServerUrl(subject.avatar);
  const swapInImage = (objectUrl: string | null): void => {
    // The row may have been torn down while the fetch was in flight; an
    // element with no parent is one nobody is looking at.
    if (objectUrl === null || !wrapper.isConnected) return;
    const img = createElement("img", {
      class: "avatar-img",
      src: objectUrl,
      alt: options.decorative === true ? "" : resolveDisplayName(subject),
      loading: "lazy",
      decoding: "async",
    });
    recoverEvictedImage(img, { url: resolved });
    // Replacing rather than hiding keeps the letter out of the accessibility
    // tree once a real picture is there.
    letter.remove();
    wrapper.style.background = "transparent";
    wrapper.insertBefore(img, wrapper.firstChild);
  };

  if (options.deferUntilVisible !== true) {
    void fetchImageAsObjectUrl(resolved).then(swapInImage);
    return wrapper;
  }

  whenVisible(wrapper, () => {
    enqueueFetch(() => {
      // Queued behind the cap, the row may be gone by the time it is its turn.
      if (!wrapper.isConnected) return Promise.resolve();
      return fetchImageAsObjectUrl(resolved).then(swapInImage);
    });
  });

  return wrapper;
}
