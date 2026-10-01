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
  void fetchImageAsObjectUrl(resolved).then((objectUrl) => {
    // The row may have been torn down while the fetch was in flight; an
    // element with no parent is one nobody is looking at.
    if (objectUrl === null || !wrapper.isConnected) return;
    const img = createElement("img", {
      class: "avatar-img",
      src: objectUrl,
      alt: resolveDisplayName(subject),
      loading: "lazy",
      decoding: "async",
    });
    recoverEvictedImage(img, { url: resolved });
    // Replacing rather than hiding keeps the letter out of the accessibility
    // tree once a real picture is there.
    letter.remove();
    wrapper.style.background = "transparent";
    wrapper.insertBefore(img, wrapper.firstChild);
  });

  return wrapper;
}
