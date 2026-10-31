import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { mimeForName, parseDrag } from "../../../src/platform/desktop/nativeFilesHost";

describe("desktop nativeFiles", () => {
  beforeEach(() => invoke.mockReset());

  it("scales the drag position by the webview zoom", () => {
    expect(parseDrag({ kind: "over", x: 300, y: 150 }, 1.5)).toEqual({
      kind: "over",
      x: 200,
      y: 100,
    });
    expect(parseDrag({ kind: "leave" }, 1)).toEqual({ kind: "leave" });
  });

  it("drops malformed events and malformed files", () => {
    expect(parseDrag(null, 1)).toBeNull();
    expect(parseDrag({ kind: "over", x: "1", y: 2 }, 1)).toBeNull();
    expect(parseDrag({ kind: "other", x: 1, y: 2 }, 1)).toBeNull();
    const drop = parseDrag(
      {
        kind: "drop",
        x: 1,
        y: 2,
        files: [{ token: 1, name: "a.png", size: 3 }, { token: 2, name: "", size: 1 }, "x"],
      },
      1,
    );
    expect(drop?.kind === "drop" && drop.files.map((f) => [f.name, f.size])).toEqual([
      ["a.png", 3],
    ]);
  });

  it("reads a dropped file once by its token, typed by its name", async () => {
    invoke.mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer);
    const drop = parseDrag(
      { kind: "drop", x: 0, y: 0, files: [{ token: 7, name: "a.PNG", size: 3 }] },
      1,
    );
    if (drop?.kind !== "drop") throw new Error("expected a drop");
    const file = await drop.files[0]!.read();
    expect(invoke).toHaveBeenCalledWith("read_staged_file", { token: 7 });
    expect(file.name).toBe("a.PNG");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(3);
  });

  it("rejects the read when the host refuses it", async () => {
    invoke.mockRejectedValueOnce("file is no longer available");
    const drop = parseDrag(
      { kind: "drop", x: 0, y: 0, files: [{ token: 1, name: "a.txt", size: 1 }] },
      1,
    );
    if (drop?.kind !== "drop") throw new Error("expected a drop");
    await expect(drop.files[0]!.read()).rejects.toThrow("file is no longer available");
  });

  it("guesses common types and leaves unknown ones empty", () => {
    expect(mimeForName("clip.mp4")).toBe("video/mp4");
    expect(mimeForName("notes")).toBe("");
    expect(mimeForName(".bashrc")).toBe("");
    expect(mimeForName("x.unknownext")).toBe("");
  });
});
