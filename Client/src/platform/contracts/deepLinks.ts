/**
 * owncord:// deep links. The contract method below has the exact signature of
 * `lib/deep-link.ts`'s former `initDeepLinks`, which B7-5 moved to
 * `platform/desktop/deepLinks.ts`. Parsing (`parseInviteLink`, `parseMessageLink`)
 * is pure and stays in `lib/deep-link.ts` — it needs no native seam at all.
 */
export interface DeepLinks {
  /** Wire owncord:// deep links. No-op outside the native host. `onInvite`
   *  fires once per recognized invite link and `onMessage` once per message
   *  permalink, on both cold start and warm launches. */
  init(
    onInvite: (code: string, host?: string) => void,
    onMessage?: (channelId: number, messageId: number) => void,
  ): Promise<void>;
}
