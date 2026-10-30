/**
 * The forum destination: what `navigation/destinations.ts` imports.
 * The post list, its tag filter and the New Post dialog load on the first forum
 * a session opens, so a server without forums never pays for them. The channel
 * controller mounts the returned element in the messages slot.
 */

import { createElement, setText } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { shellText } from "../../i18n/shell";
import type { ForumViewContext } from "../navigation/destinations";

const log = createLogger("forum-view");

/** The forum destination's view builder (navigation/destinations.ts). */
export function buildForumView(ctx: ForumViewContext): HTMLElement {
  const root = createElement("div", { class: "forum-view", "data-testid": "forum-view" });
  import("./ForumView").then(
    ({ renderForumView }) => {
      if (!ctx.signal.aborted) renderForumView(root, ctx);
    },
    (err: unknown) => {
      log.error("Forum view failed to load", { error: String(err) });
      if (ctx.signal.aborted) return;
      const note = createElement("p", { class: "forum-empty", role: "alert" });
      setText(note, shellText("channel.forumLoadFailed"));
      root.appendChild(note);
    },
  );
  return root;
}
