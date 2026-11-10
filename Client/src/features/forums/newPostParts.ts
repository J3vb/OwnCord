/**
 * New Post dialog pieces that hold no dialog state: the refusal text for a
 * server error code and the attachment and field types.
 */

import type { Disposable } from "@lib/disposable";
import { WsErrorCode } from "@lib/protocolTypes";
import { forumsText } from "../../i18n/forums";

/** The dialog's refusal line for a server error code. */
export function postErrorText(code: string): string {
  switch (code) {
    case WsErrorCode.FORBIDDEN:
      return forumsText("error.FORBIDDEN");
    case WsErrorCode.NOT_FOUND:
      return forumsText("error.NOT_FOUND");
    case WsErrorCode.RATE_LIMITED:
      return forumsText("error.RATE_LIMITED");
    case WsErrorCode.SLOW_MODE:
      return forumsText("error.SLOW_MODE");
    case WsErrorCode.CONFLICT:
      return forumsText("error.CONFLICT");
    case "UNCONFIRMED":
      return forumsText("error.UNCONFIRMED");
    case "OFFLINE":
      return forumsText("error.OFFLINE");
    default:
      return forumsText("error.other");
  }
}

export interface Attachment {
  readonly file: File;
  id: string | null;
  status: "uploading" | "done" | "failed";
  readonly owner: Disposable;
  readonly chip: HTMLElement;
}

export type ErrorField = "title" | "tags" | "message";
