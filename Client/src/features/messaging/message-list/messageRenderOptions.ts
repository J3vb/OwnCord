import type { MessageListOptions } from "../MessageList";

/** What a row render reads beyond the list's own options. */
export interface MessageRenderOptions extends MessageListOptions {
  /** Authors whose messages are hidden, so a reply quoting one shows no content. */
  readonly blockedUsers?: ReadonlySet<number>;
  /** The list's own lifetime: owners that must outlive a row rebuild (the End poll confirm) use it. */
  readonly listSignal?: AbortSignal;
}
