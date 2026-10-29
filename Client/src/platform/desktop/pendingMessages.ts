/**
 * Desktop pending-message storage: the native surface behind the
 * `PendingMessageStore` contract — the same verified encrypted store the
 * credentials use.
 *
 * Lifted verbatim from `lib/pendingMessages.ts`: same commands, same
 * arguments, same error handling — including the environment guard that keeps
 * a browser build's drafts in memory and never writes message text to Web
 * Storage.
 */
import { isTauri } from "@tauri-apps/api/core";
import { invokeOrThrow } from "./nativeInvoke";
import type { PendingMessageStore } from "../contracts/pendingMessages";

export const pendingMessages: PendingMessageStore = {
  async load(owner) {
    if (!isTauri()) return null;
    return invokeOrThrow<string | null>("load_pending_messages", { ...owner });
  },
  async save(owner, value) {
    if (!isTauri()) return;
    await invokeOrThrow("save_pending_messages", { ...owner, value });
  },
  async delete(owner) {
    if (!isTauri()) return;
    await invokeOrThrow("delete_pending_messages", { ...owner });
  },
};
