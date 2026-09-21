/**
 * Desktop external-content broker: the native surface behind the
 * `ExternalContentBroker` contract — `external_preview` answers with the typed
 * minimum, `external_image` with raw IPC bytes (never base64), which become a
 * same-origin `Blob` here so the GIF-freeze canvas path stays untainted.
 *
 * The native side reports a refusal as its failure class and nothing more;
 * anything else — including no native host at all — reads as "unavailable",
 * so a caller never has to tell a thrown error from a refusal.
 */
import type {
  ExternalContentBroker,
  ExternalContentFailure,
  ExternalContentResult,
  ExternalPreview,
} from "../contracts/externalContent";

const FAILURES: readonly string[] = [
  "blocked-destination",
  "too-many-redirects",
  "oversized",
  "wrong-type",
  "unavailable",
] satisfies readonly ExternalContentFailure[];

// Each command is named literally at its call site below, so the
// platform-contracts count (a grep for `invoke("…")`) sees both.
type Invoke = (typeof import("@tauri-apps/api/core"))["invoke"];

async function call<T>(ask: (invoke: Invoke) => Promise<T>): Promise<ExternalContentResult<T>> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return { ok: true, value: await ask(invoke) };
  } catch (err) {
    const failure = typeof err === "string" && FAILURES.includes(err) ? err : "unavailable";
    return { ok: false, failure: failure as ExternalContentFailure };
  }
}

export const externalContent: ExternalContentBroker = {
  preview: (partition, url) =>
    call((invoke) => invoke<ExternalPreview>("external_preview", { partition, url })),

  async image(partition, source) {
    const args = "handle" in source ? { handle: source.handle } : { url: source.url };
    const result = await call((invoke) =>
      invoke<ArrayBuffer>("external_image", { partition, ...args }),
    );
    return result.ok ? { ok: true, value: new Blob([result.value]) } : result;
  },
};
