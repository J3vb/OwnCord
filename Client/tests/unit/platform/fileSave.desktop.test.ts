// Desktop binding for the FileSaver suite: `platform/desktop`'s save dialog
// and file write. B7-4 ran the same suite file against the in-place seam in
// `message-list/attachments.ts` first (proving it could fail and pinning
// today's behaviour), then re-bound it here. The legacy binding is deleted
// with this commit: its export is now internal.
//
// `attachments.ts` pulls in the icon/dom/media helpers at module load, but
// this binding imports the desktop module directly, so only the two plugins
// need mocking.
import { vi } from "vitest";
import type { FileSaver } from "../../../src/platform/contracts/fileSave";
import { describeFileSaverSuite } from "./fileSave.suite";

const { saveMock, writeFileMock } = vi.hoisted(() => ({
  saveMock: vi.fn<(options?: { defaultPath?: string }) => Promise<string | null>>(),
  writeFileMock: vi.fn<(path: string, data: Uint8Array) => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: writeFileMock }));

const mod = await import("../../../src/platform/desktop/fileSave");
const desktopBinding: FileSaver = mod.fileSaver;

const written: { path: string; data: Uint8Array }[] = [];

/** A native host that is present and healthy; each control method narrows
 *  that, so a suite test that sets up nothing gets the working host. */
function reset(): void {
  saveMock.mockReset();
  writeFileMock.mockReset();
  saveMock.mockResolvedValue(null);
  writeFileMock.mockImplementation((path, data) => {
    written.push({ path, data });
    return Promise.resolve();
  });
  written.length = 0;
}

describeFileSaverSuite(async () => {
  reset();
  return {
    subject: desktopBinding,
    native: {
      dialogResolves(path: string | null) {
        reset();
        saveMock.mockResolvedValue(path);
      },
      dialogFailsWith(error: unknown) {
        reset();
        saveMock.mockRejectedValue(error);
      },
      written: () => written.map((entry) => ({ ...entry })),
      writeFailsWith(error: unknown) {
        reset();
        writeFileMock.mockRejectedValue(error);
      },
    },
  };
});
