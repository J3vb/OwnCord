import { vi } from "vitest";

/**
 * Serve the Twemoji packs (emojiImage.ts) from `svgs` (FE0F-free name -> SVG)
 * as one pack, and hand out numbered blob URLs. Returns the undo.
 */
export function stubTwemoji(svgs: Record<string, string>): () => void {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/index.json")) return Promise.resolve(Response.json([""]));
    if (url.endsWith("/pack-0.json")) return Promise.resolve(Response.json(svgs));
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const original = URL.createObjectURL;
  let next = 0;
  URL.createObjectURL = vi.fn(() => `blob:twemoji-${++next}`);
  return () => {
    vi.unstubAllGlobals();
    URL.createObjectURL = original;
  };
}
