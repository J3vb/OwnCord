/**
 * The avatar block of a DM list row: a single circle with a presence dot for a
 * 1:1 DM, or the overlapping faces (or uploaded icon) of a group.
 */

import { createElement } from "@lib/dom";
import { applyStatusIndicator } from "@lib/ui/statusIndicator";
import { avatarAnimationMode, isRenderableAvatar, setAvatarSource } from "../profiles/avatar";
import {
  fetchImageAsObjectUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "../messaging/content/attachments";
import type { DmConversation, DmParticipant } from "./dmConversation";

/**
 * Fill one avatar circle: the letter immediately, the picture swapped in once
 * fetched. `<img src>` cannot carry the bearer token an authenticated
 * `/api/v1/files/{id}` avatar needs, so the URL is always fetched through the
 * same cert-pinned path attachments and custom emoji use rather than assigned
 * directly.
 */
function paintAvatar(el: HTMLElement, avatar: string | null, label: string): void {
  // The letter lives in its own node so the swap below can remove just it —
  // anything else in the circle (the 1:1 presence dot) must survive the image.
  const letter = document.createTextNode(label.charAt(0).toUpperCase());
  el.appendChild(letter);
  if (!isRenderableAvatar(avatar)) return;
  const resolved = resolveServerUrl(avatar);
  void fetchImageAsObjectUrl(resolved).then(async (objectUrl) => {
    if (objectUrl === null || !el.isConnected) return;
    const img = createElement("img", { alt: label });
    recoverEvictedImage(img, { url: resolved });
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.borderRadius = "50%";
    const current = (): boolean => el.isConnected;
    if (!(await setAvatarSource(img, objectUrl, () => avatarAnimationMode(el), current))) return;
    letter.remove();
    el.insertBefore(img, el.firstChild);
  });
}

/**
 * The two overlapping faces of a group DM. Shared by the DM row and the chat
 * header so a group looks the same in both.
 *
 * A group with an uploaded icon shows that picture instead of the
 * faces. The faces are drawn first, so a group is never an empty circle; the
 * icon is fetched like any avatar and replaces them when it arrives, even if
 * the stack has been detached meanwhile (the image cache owns the object URL,
 * so it is not revoked here). If the picture then fails to decode the faces
 * are drawn again.
 */
export function buildGroupAvatarStack(
  channelId: number,
  participants: readonly DmParticipant[],
  fallbackLabel: string,
  background: string,
  testId = `dm-avatar-stack-${channelId}`,
  icon: string | null = null,
): HTMLDivElement {
  const stack = createElement("div", {
    class: "dm-avatar dm-avatar-stack",
    "data-testid": testId,
  });
  const drawFaces = (): void => {
    const shown = participants.slice(0, 2);
    // An empty group (every other member has left) still needs a mark, so fall
    // back to the row's own label rather than rendering an empty circle.
    const faces = shown.length > 0 ? shown : [{ id: 0, username: fallbackLabel, avatar: null }];
    faces.forEach((p, i) => {
      const face = createElement("div", { class: `dm-avatar-face dm-avatar-face-${i}` });
      face.style.background = background;
      paintAvatar(face, p.avatar, p.username);
      stack.appendChild(face);
    });
  };
  drawFaces();
  if (!isRenderableAvatar(icon)) return stack;
  const resolved = resolveServerUrl(icon);
  void fetchImageAsObjectUrl(resolved).then((objectUrl) => {
    if (objectUrl === null) return;
    const img = createElement("img", {
      src: objectUrl,
      alt: "",
      class: "dm-avatar-icon-img",
      "data-testid": `${testId}-icon`,
    });
    recoverEvictedImage(img, { url: resolved });
    img.addEventListener(
      "error",
      () => {
        stack.replaceChildren();
        drawFaces();
      },
      { once: true },
    );
    stack.replaceChildren(img);
  });
  return stack;
}

/**
 * The avatar block for a row: one circle for a 1:1 DM with a presence dot, or
 * two overlapping circles for a group.
 *
 * A group deliberately gets no presence dot — "is this group online" has no
 * answer, and showing the first member's would be a fact about one person
 * presented as a fact about the conversation.
 */
export function buildAvatar(convo: DmConversation): HTMLDivElement {
  const avatarBg = convo.avatarColor ?? "#5865F2";

  if (convo.isGroup === true) {
    return buildGroupAvatarStack(
      convo.channelId,
      convo.participants ?? [],
      convo.username,
      avatarBg,
      undefined,
      convo.icon ?? null,
    );
  }

  const avatar = createElement("div", { class: "dm-avatar" });
  avatar.style.background = avatarBg;
  paintAvatar(avatar, convo.avatar, convo.username);

  const statusDot = createElement("span", { class: "dm-status" });
  applyStatusIndicator(statusDot, convo.status ?? "offline", convo.mobile === true);
  avatar.appendChild(statusDot);
  return avatar;
}
