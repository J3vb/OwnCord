// The browser external-content broker: the server's. A page's own `fetch` has
// none of the native broker's address classification, redirect, size or type
// bounds (docs/trust-model.md), so the page never fetches a URL a
// message author named. It asks the server that served it instead
// (`/api/v1/external/*`, Server/externalcontent), which applies the same
// policy and answers with the same typed minimum and failure names. The linked
// host sees the server, never the viewer.
//
// The calls carry the session token the browser credential store keeps for
// this page's host (the web build always keeps one while signed in). Without
// one, or on any answer that is not the broker's, the result is `unavailable`.
import type {
  ExternalContentBroker,
  ExternalContentFailure,
  ExternalContentResult,
  ExternalImageHandle,
  ExternalPreview,
} from "../contracts/externalContent";
import { credentials } from "./credentials";

const BASE = "/api/v1/external";

const FAILURES: ReadonlySet<string> = new Set<ExternalContentFailure>([
  "blocked-destination",
  "too-many-redirects",
  "oversized",
  "wrong-type",
  "expired-handle",
  "unavailable",
]);

const UNAVAILABLE = { ok: false, failure: "unavailable" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function dimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A refusal body (`{"ok":false,"failure":...}`) as a typed result. */
function refusal(body: unknown): { readonly ok: false; readonly failure: ExternalContentFailure } {
  if (isRecord(body) && body["ok"] === false && typeof body["failure"] === "string") {
    const failure = body["failure"];
    if (FAILURES.has(failure)) return { ok: false, failure: failure as ExternalContentFailure };
  }
  return UNAVAILABLE;
}

function toPreview(value: unknown): ExternalPreview | null {
  if (!isRecord(value)) return null;
  const image = text(value["image"]);
  const width = dimension(value["image_width"]);
  const height = dimension(value["image_height"]);
  return {
    title: text(value["title"]),
    description: text(value["description"]),
    siteName: text(value["site_name"]),
    image: image === null || image === "" ? null : (image as ExternalImageHandle),
    ...(width === undefined ? {} : { imageWidth: width }),
    ...(height === undefined ? {} : { imageHeight: height }),
  };
}

/** GET a broker route with the page's session, or null when there is none
 *  or the request fails before an answer. */
async function call(path: string, params: Record<string, string>): Promise<Response | null> {
  const saved = await credentials.load(globalThis.location.host);
  if (saved === null) return null;
  const query = new URLSearchParams(params).toString();
  try {
    return await globalThis.fetch(`${BASE}${path}?${query}`, {
      // i18n-exempt: protocol header, never rendered
      headers: { Authorization: `Bearer ${saved.token}` },
      credentials: "omit",
    });
  } catch {
    return null;
  }
}

async function json(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

export const externalContent: ExternalContentBroker = {
  // The server partitions its handles by member, and a teardown drops the
  // renderer's own cache, so the partition is not sent.
  async preview(_partition, url): Promise<ExternalContentResult<ExternalPreview>> {
    const resp = await call("/preview", { url });
    if (resp === null || !resp.ok) return UNAVAILABLE;
    const body = await json(resp);
    if (isRecord(body) && body["ok"] === true) {
      const preview = toPreview(body["value"]);
      return preview === null ? UNAVAILABLE : { ok: true, value: preview };
    }
    return refusal(body);
  },

  async image(_partition, source): Promise<ExternalContentResult<Blob>> {
    const params: Record<string, string> =
      "handle" in source ? { handle: source.handle } : { url: source.url };
    const resp = await call("/image", params);
    if (resp === null || !resp.ok) return UNAVAILABLE;
    const type = (resp.headers.get("Content-Type") ?? "").toLowerCase();
    if (type.startsWith("image/")) {
      try {
        return { ok: true, value: await resp.blob() };
      } catch {
        return UNAVAILABLE;
      }
    }
    return refusal(await json(resp));
  },
};
