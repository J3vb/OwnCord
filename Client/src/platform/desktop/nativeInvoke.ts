// The shared door to a host command. Every Tauri `invoke` in this folder either
// sits in its own try/catch or goes through here, so a rejected command (or a
// missing bridge) comes back as a value or a typed error, never as the raw
// string the host rejected with. `local/invoke-needs-try-catch` is an error
// everywhere in the folder but this file.
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";

/** A host command that failed. `reason` is what the host rejected with
 *  (usually a string, sometimes a `{stage, message}` object), kept for callers
 *  that classify it; `message` is its text. */
export class NativeCallError extends Error {
  constructor(
    readonly command: string,
    readonly reason: unknown,
  ) {
    super(reasonText(reason));
    this.name = "NativeCallError";
  }
}

export type NativeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: NativeCallError };

function reasonText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    const { message } = reason;
    if (typeof message === "string") return message;
  }
  return String(reason);
}

/** Runs `command`; never rejects. The command is sent before the first await,
 *  so fire-and-forget callers keep their order with the host. */
export async function tryInvoke<T>(command: string, args?: InvokeArgs): Promise<NativeResult<T>> {
  try {
    const value = await (args === undefined ? invoke<T>(command) : invoke<T>(command, args));
    return { ok: true, value };
  } catch (reason) {
    return { ok: false, error: new NativeCallError(command, reason) };
  }
}

/** Runs `command` for a contract whose callers handle the failure: rejects
 *  with a `NativeCallError`. */
export async function invokeOrThrow<T>(command: string, args?: InvokeArgs): Promise<T> {
  const result = await tryInvoke<T>(command, args);
  if (!result.ok) throw result.error;
  return result.value;
}
