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
// platform-contracts count (a grep for the literal command name) sees both.
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

/** The raster type of `bytes` by signature — the same allowlist the native
 *  broker already enforced — so the Blob a caller gets says what it holds. */
function sniffImageType(bytes: Uint8Array): string {
  const starts = (sig: readonly number[], at = 0): boolean =>
    sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (starts([0x66, 0x74, 0x79, 0x70], 4)) return "image/avif";
  if (starts([0x42, 0x4d])) return "image/bmp";
  return "";
}

export const externalContent: ExternalContentBroker = {
  preview: (partition, url) =>
    call((invoke) => invoke<ExternalPreview>("external_preview", { partition, url })),

  async image(partition, source) {
    const args = "handle" in source ? { handle: source.handle } : { url: source.url };
    const result = await call((invoke) =>
      invoke<ArrayBuffer>("external_image", { partition, ...args }),
    );
    if (!result.ok) return result;
    const type = sniffImageType(new Uint8Array(result.value));
    return { ok: true, value: new Blob([result.value], { type }) };
  },
};
