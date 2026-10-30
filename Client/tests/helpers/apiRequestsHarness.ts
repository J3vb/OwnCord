import { createApiClient } from "../../src/lib/api";

export type Api = ReturnType<typeof createApiClient>;

export function okResponse(data: unknown = {}, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

export function failResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: false,
    status,
    statusText: "Status Text",
    json: () => Promise.resolve(body),
    headers: new Headers(headers),
  } as unknown as Response;
}

export const BASE = "https://host.test:8443/api/v1";
