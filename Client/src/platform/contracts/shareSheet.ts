/**
 * The system share sheet: hand a file or a piece of text to another app (mail,
 * Drive, a chat app). Only the Android app has one today.
 */
export interface ShareSheet {
  /** True where the host has a share sheet; callers offer Share only then. */
  readonly available: boolean;
  /** Open the share sheet on `data`, named `name`. Resolves once the sheet is
   *  showing; rejects when the host refuses or has no sheet. */
  shareFile(name: string, data: Uint8Array): Promise<void>;
  /** Open the share sheet on `text`. Same resolution as `shareFile`. */
  shareText(text: string): Promise<void>;
}
