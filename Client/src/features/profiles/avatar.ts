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
 * The pure name/letter helpers stay in `@lib/ui/avatar`; this module owns the DOM
 * and the fetch, so it lives beside the attachments helper it needs.
 */

import { createElement } from "@lib/dom";
import { avatarInitial, resolveDisplayName, type AvatarSubject } from "@lib/ui/avatar";
import { animatedStill, bindAnimatedImage, type AnimationMode } from "@lib/ui/animatedStill";
import {
  fetchImageAsObjectUrl,
  isSafeUrl,
  cachedImageBytes,
  recoverEvictedImage,
  resolveServerUrl,
} from "../messaging/content/attachments";

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
  /**
   * An animated avatar shows its first frame and plays while the row
   * around it is hovered (`"hover"`, the default), or plays from the start
   * (`"always"`: the profile popup). Never under reduced motion.
   */
  readonly animate?: "hover" | "always";
}

/** The rows whose hover plays an animated avatar inside them, as on Discord:
 *  a message, a member, a DM, a voice participant, the user bar. Anything
 *  else plays when the avatar itself is hovered. */
const AVATAR_HOVER_SCOPE = ".message, .member-item, .dm-item, .voice-user-item, .user-bar";
/** The still is drawn no larger than this: past any avatar surface at 2x. */
const AVATAR_STILL_SIDE = 256;

/** The first frame of the avatar at `objectUrl` (from `fetchImageAsObjectUrl`)
 *  when it is animated, else null. */
export function avatarStill(
  objectUrl: string,
  maxSide = AVATAR_STILL_SIDE,
): Promise<string | null> {
  const read = cachedImageBytes(objectUrl);
  // Not from the image cache (a data: URI, an external picture): shown as is.
  if (read === null) return Promise.resolve(null);
  return animatedStill(objectUrl, maxSide, read);
}

/** How an avatar inside `el` plays: with its row's hover, or always. */
export function avatarAnimationMode(
  el: HTMLElement,
  animate: "hover" | "always" = "hover",
): AnimationMode {
  if (animate === "always") return "always";
  return { hover: el.closest<HTMLElement>(AVATAR_HOVER_SCOPE) ?? el };
}

/**
 * Show `objectUrl` on `img`: as it is when it is still, as its first frame
 * that plays per `mode` when animated. Resolves once `src` is set, so an
 * image inserted after it never flashes the animation; resolves false (and
 * sets nothing) when `stillCurrent` says the picture changed meanwhile.
 */
export async function setAvatarSource(
  img: HTMLImageElement,
  objectUrl: string,
  mode: () => AnimationMode,
  stillCurrent: () => boolean = () => true,
  maxSide = AVATAR_STILL_SIDE,
): Promise<boolean> {
  const still = await avatarStill(objectUrl, maxSide);
  if (!stillCurrent()) return false;
  if (still === null) img.src = objectUrl;
  else bindAnimatedImage(img, objectUrl, still, mode());
  return true;
}

/** Fetches in flight at once for `deferUntilVisible` avatars. */
const MAX_CONCURRENT_AVATAR_FETCHES = 6;
/** How far outside the viewport a row counts as visible. The root is the
 *  viewport, so rows clipped by the list's own scroll box still load only as
 *  they scroll in. */
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
    // A job that throws before returning its promise still frees its slot.
    let pending: Promise<unknown>;
    try {
      pending = job();
    } catch {
      pending = Promise.resolve();
    }
    pending.then(release, release);
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
  const bindAnimationOnFirstUse = (
    img: HTMLImageElement,
    objectUrl: string,
    still: string,
  ): void => {
    const bind = (): void => {
      if (!wrapper.isConnected) return;
      wrapper.removeEventListener("pointerenter", bind);
      wrapper.removeEventListener("focusin", bind);
      // Binding checks the hover and focus already on it, so it starts playing.
      bindAnimatedImage(img, objectUrl, still, avatarAnimationMode(wrapper, options.animate));
    };
    wrapper.addEventListener("pointerenter", bind);
    wrapper.addEventListener("focusin", bind);
  };

  const swapInImage = (objectUrl: string | null): Promise<void> | undefined => {
    if (objectUrl === null) return undefined;
    const img = createElement("img", {
      class: "avatar-img",
      alt: options.decorative === true ? "" : resolveDisplayName(subject),
      loading: "lazy",
      decoding: "async",
    });
    recoverEvictedImage(img, { url: resolved });
    return avatarStill(objectUrl).then((still) => {
      if (still === null) img.src = objectUrl;
      else if (wrapper.isConnected) {
        bindAnimatedImage(img, objectUrl, still, avatarAnimationMode(wrapper, options.animate));
      } else {
        // Not on screen: a host may build the avatar ahead of showing it (a
        // call tile kept for when the camera goes off), or the row was torn
        // down. Show the first frame either way, and bind the animation only
        // once someone points at it, so a discarded avatar holds no observer.
        img.src = still;
        bindAnimationOnFirstUse(img, objectUrl, still);
      }
      // Replacing rather than hiding keeps the letter out of the accessibility
      // tree once a real picture is there.
      letter.remove();
      wrapper.style.background = "transparent";
      wrapper.insertBefore(img, wrapper.firstChild);
    });
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
