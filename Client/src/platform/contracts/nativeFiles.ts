/** A file the host read from a drop or the clipboard. `read` works once. */
export interface NativeFile {
  readonly name: string;
  readonly size: number;
  read(): Promise<File>;
}

/** A drag from the OS file manager, in CSS pixels of the page. */
export type NativeFileDrag =
  | { readonly kind: "over"; readonly x: number; readonly y: number }
  | {
      readonly kind: "drop";
      readonly x: number;
      readonly y: number;
      readonly files: readonly NativeFile[];
    }
  | { readonly kind: "leave" };

/**
 * Files from the OS that the webview cannot hand the page itself. WebKitGTK
 * (the Linux desktop) gives a drop or a paste of copied files only their
 * uri-list, so the host reads them. Where the webview hands over real files
 * (WebView2, a browser) `available` is false and the page's own drop and
 * paste events carry them.
 */
export interface NativeFiles {
  readonly available: boolean;
  /** Subscribe to drags from the file manager; returns the unsubscribe. */
  onDrag(handler: (drag: NativeFileDrag) => void): () => void;
  /** Files copied in a file manager. Empty when the clipboard holds none or
   *  the read failed; never rejects. */
  clipboardFiles(): Promise<readonly NativeFile[]>;
}
