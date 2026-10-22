// Browser binding for the FileSaver suite (6.13d): a save is a download of a
// blob through `<a download>`. The browser shows no dialog and reports no
// path, so the suite runs with `nativeDialog: false`; the tests below pin the
// download in place of the dialog-and-path cases it skips.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileSaver } from "../../../src/platform/contracts/fileSave";
import { describeFileSaverSuite } from "./fileSave.suite";

interface Download {
  readonly name: string;
  readonly href: string;
  readonly inDocument: boolean;
}

class RecordingBlob extends Blob {
  constructor(readonly recorded: readonly BlobPart[]) {
    super([...recorded]);
  }
}

const downloads: Download[] = [];
const created: RecordingBlob[] = [];
const revoked: string[] = [];
let failure: unknown = null;

function install(): void {
  downloads.length = 0;
  created.length = 0;
  revoked.length = 0;
  failure = null;
  vi.stubGlobal("Blob", RecordingBlob);
  URL.createObjectURL = (blob: Blob): string => {
    if (failure !== null) throw failure;
    created.push(blob as RecordingBlob);
    return `blob:test/${created.length}`;
  };
  URL.revokeObjectURL = (url: string): void => {
    revoked.push(url);
  };
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({
      name: this.download,
      href: this.href,
      inDocument: document.body.contains(this),
    });
  });
}

async function load(): Promise<FileSaver> {
  vi.resetModules();
  install();
  return (await import("../../../src/platform/browser/fileSave")).fileSaver;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describeFileSaverSuite(
  async () => ({
    subject: await load(),
    native: {
      dialogResolves: () => undefined,
      dialogFailsWith: () => undefined,
      written: () => [],
      writeFailsWith(error: unknown) {
        failure = error;
      },
    },
  }),
  { nativeDialog: false },
);

describe("browser file save", () => {
  let saver: FileSaver;
  beforeEach(async () => {
    saver = await load();
  });

  it("has no dialog: the suggested name stands for the location", async () => {
    await expect(saver.pickSaveLocation("report.pdf")).resolves.toBe("report.pdf");
    expect(downloads).toEqual([]);
  });

  it("downloads the caller's bytes under the file name of the path", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await saver.writeFile("/home/alice/report.pdf", bytes);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.name).toBe("report.pdf");
    expect(downloads[0]!.href).toBe("blob:test/1");
    expect(created[0]!.recorded).toEqual([bytes]);
  });

  it("names the download from a Windows path, and falls back for an empty name", async () => {
    await saver.writeFile("C:\\Users\\alice\\a.txt", new Uint8Array());
    await saver.writeFile("dir/", new Uint8Array());
    expect(downloads.map((d) => d.name)).toEqual(["a.txt", "download"]);
  });

  it("clicks a link that is in the page, then removes it", async () => {
    await saver.writeFile("a.bin", new Uint8Array([1]));
    expect(downloads[0]!.inDocument).toBe(true);
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("releases the blob URL a while after the click, not before", async () => {
    vi.useFakeTimers();
    await saver.writeFile("a.bin", new Uint8Array([1]));
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(revoked).toEqual(["blob:test/1"]);
  });

  it("rejects, and leaves no link behind, when the download cannot start", async () => {
    failure = new Error("blocked");
    await expect(saver.writeFile("a.bin", new Uint8Array([1]))).rejects.toThrow("blocked");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revoked).toEqual([]);
  });
});
