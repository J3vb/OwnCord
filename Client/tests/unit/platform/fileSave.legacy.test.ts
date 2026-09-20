// Legacy binding for the FileSaver suite: today's `downloadFile` save/write
// pair from `message-list/attachments.ts`, wrapped with no cast against the
// contract. B7-4 re-runs `fileSave.suite.ts` against `platform/desktop`
// instead of this file.
//
// `attachments.ts` pulls in the icon/dom/media helpers at module load; the
// mock block below is the same one `attachments-auth.test.ts` uses to keep
// that import inert.
import { vi } from "vitest";
import type { FileSaver } from "../../../src/platform/contracts/fileSave";
import { describeFileSaverSuite } from "./fileSave.suite";

const { saveMock, writeFileMock } = vi.hoisted(() => ({
  saveMock: vi.fn<(options?: { defaultPath?: string }) => Promise<string | null>>(),
  writeFileMock: vi.fn<(path: string, data: Uint8Array) => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: writeFileMock }));
vi.mock("@lib/httpProxy", () => ({ ensureHttpProxy: vi.fn() }));
vi.mock("@stores/auth.store", () => ({ getToken: vi.fn() }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@lib/icons", () => ({ createIcon: () => document.createElement("span") }));
vi.mock("@lib/media-visibility", () => ({ observeMedia: vi.fn() }));
vi.mock("../../../src/components/message-list/media", () => ({ openImageLightbox: vi.fn() }));

const mod = await import("../../../src/components/message-list/attachments");
const legacy: FileSaver = mod.fileSaver;

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
    subject: legacy,
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
