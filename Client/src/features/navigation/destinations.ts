/**
 * The destination map: where later features
 * plug into the existing shell. There is no new navigation rail.
 *
 * - Message Requests: "Message Requests (N)" at the top of DM mode.
 * - Moderation: "Moderation" beside "Audit Log", shown only with
 *   MODERATE_MEMBERS, opening in the content area (not the browser).
 * - Safety: a Settings tab, which the notice banner links to.
 *
 * Back: close or Escape on a content view returns to the channel the user
 * came from, through the sidebar's existing channelBeforeDm path.
 *
 * Badge meaning: N is the pending-request count. It badges the DM header
 * separately from unread and never adds to unread or mention counts. The
 * Moderation entry carries no badge in beta.
 *
 * A destination with no entry in NAVIGATION_DESTINATIONS shows no entry
 * anywhere, so nothing empty or nonfunctional is on screen before its
 * feature ships. Each feature milestone adds its own entry here.
 *
 * Visibility is only an affordance: the server authorizes every read and
 * action behind a destination, and nothing here fetches to decide it.
 */

import type { ApiClient } from "@lib/api";
import type { AvatarSubject } from "@lib/ui/avatar";
import type { WsClient } from "@lib/ws";
import { buildForumView } from "../forums/view";
import { pendingRequestCount } from "../message-requests/store";
import { buildInbox } from "../message-requests/view";
import { buildModerationCenter } from "../moderation/view";
import { buildSafetyPane } from "../reports/safetyPane";

/** A destination that opens in the content area, in place of the chat column. */
export type ContentViewId = "requests" | "moderation";

export interface FeatureViewContext {
  /**
   * Aborts when the view goes away: closed, replaced, its permission lost,
   * the account signed out or the page torn down. Bind every listener,
   * request and timer to it, and drop any result that lands after it aborts.
   */
  readonly signal: AbortSignal;
  /** Leave the view the way its Close button does. */
  readonly close: () => void;
  /** The page's API client; the server authorizes every read behind a view. */
  readonly api: ApiClient;
}

/**
 * What a forum channel's post list needs. A forum is a channel, not a
 * content-area view: it is mounted by `ChannelController` in the messages slot
 * (the channel's own signal aborts it), so it carries no `close`.
 */
export interface ForumViewContext {
  readonly channelId: number;
  /** The mounted channel's lifetime: bind every listener, request and timer to it. */
  readonly signal: AbortSignal;
  readonly api: ApiClient;
  /** For `forum_post_create`; the post list itself reads over REST. */
  readonly ws: WsClient;
  /** Open a post in the thread panel beside the list. */
  readonly openPost: (threadId: number) => void;
  /** A post author's avatar (the UI layer's builder; features may not import
   *  it). Without one, rows show the author's initial. */
  readonly avatar?: (subject: AvatarSubject, className: string) => HTMLElement;
}

/** Builds a view's body. Called on every open; a view is never kept while closed. */
export type FeatureViewBuilder = (ctx: FeatureViewContext) => HTMLElement;

/** A live count for an entry. */
export interface CountSource {
  readonly get: () => number;
  /** Returns the unsubscribe function. */
  readonly subscribe: (onChange: () => void) => () => void;
}

export interface NavigationDestinations {
  /** The inbox. `pending` is N for the entry label and the DM header badge. */
  readonly requests?: { readonly build: FeatureViewBuilder; readonly pending: CountSource };
  /** The Moderation Center. The open-report count belongs inside the view. */
  readonly moderation?: { readonly build: FeatureViewBuilder };
  /**
   * Personal notices, restrictions, own reports and appeals.
   * `signal` is the tab's lifetime; `api` reads the caller's own records.
   */
  readonly safety?: {
    readonly build: (signal: AbortSignal, api: ApiClient) => HTMLDivElement;
  };
  /** A forum channel's post list, mounted by the channel controller. */
  readonly forum?: { readonly build: (ctx: ForumViewContext) => HTMLElement };
}

/** The destinations this build ships. */
export const NAVIGATION_DESTINATIONS: NavigationDestinations = {
  requests: { build: buildInbox, pending: pendingRequestCount },
  moderation: { build: buildModerationCenter },
  safety: { build: buildSafetyPane },
  forum: { build: buildForumView },
};
