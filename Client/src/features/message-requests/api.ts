/**
 * The Message Requests adapter (B9-5): the one place the B5-6 wire shape
 * (GET /api/v1/dm-requests and the dm_request frame) becomes the inbox model.
 *
 * The sender's `avatar` is dropped here, on purpose. It can be a
 * stranger-controlled URL, and a request must not fetch anything before the
 * recipient accepts it, so nothing past this point can load it by mistake.
 */

import type { DmRequestListItem } from "@lib/types";

export interface MessageRequest {
  readonly id: number;
  readonly channelId: number;
  readonly sender: {
    readonly id: number;
    readonly username: string;
    readonly displayName: string;
  };
  /** The held first message as plain text; null when it carries no text. */
  readonly preview: { readonly content: string; readonly timestamp: string } | null;
  readonly createdAt: string;
}

export function mapRequest(w: DmRequestListItem): MessageRequest {
  return {
    id: w.id,
    channelId: w.channel_id,
    sender: {
      id: w.sender.id,
      username: w.sender.username,
      displayName: w.sender.display_name,
    },
    preview:
      w.preview === null ? null : { content: w.preview.content, timestamp: w.preview.timestamp },
    createdAt: w.created_at,
  };
}
