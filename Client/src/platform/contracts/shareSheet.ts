import type { NativeFile } from "./nativeFiles";

/** What another app shared to OwnCord: files, text (a link, a note), or both. */
export interface ReceivedShare {
  readonly files: readonly NativeFile[];
  /** Empty when the share carried no text. */
  readonly text: string;
}

/**
 * The system share sheet, both ways: hand a file or a piece of text to another
 * app (mail, Drive, a chat app), and take what another app shares to OwnCord.
 * Only the Android app has one today.
 */
export interface ShareSheet {
  /** True where the host has a share sheet; callers offer Share only then. */
  readonly available: boolean;
  /** Open the share sheet on `data`, named `name`. Resolves once the sheet is
   *  showing; rejects when the host refuses or has no sheet. */
  shareFile(name: string, data: Uint8Array): Promise<void>;
  /** Open the share sheet on `text`. Same resolution as `shareFile`. */
  shareText(text: string): Promise<void>;
  /** Subscribe to shares from other apps, each delivered once; a share that
   *  arrived before the subscription is delivered to it. Returns the
   *  unsubscribe. Never fires where `available` is false. */
  onReceived(handler: (share: ReceivedShare) => void): () => void;
}
