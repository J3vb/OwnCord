/**
 * Save and share in the Android app: no save dialog, the host puts a save in
 * Pictures/OwnCord or Downloads and says which, and Share opens the system
 * sheet (androidFiles.ts, files.rs, FilesPlugin.kt).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggerMock } from "../../helpers/loggerMock";
import { clearHost, hostAndroidApp, hostDesktopApp } from "../../helpers/androidHost";

const { invokeMock, dialogMock, fsWriteMock, showToastMock, fetchServerFileMock } = vi.hoisted(
  () => ({
    invokeMock: vi.fn(),
    dialogMock: vi.fn(),
    fsWriteMock: vi.fn(),
    showToastMock: vi.fn(),
    fetchServerFileMock: vi.fn(),
  }),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: dialogMock }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: fsWriteMock }));
vi.mock("@lib/logger", () => loggerMock());
vi.mock("@lib/icons", () => ({ createIcon: () => document.createElement("span") }));
vi.mock("@lib/ui/toast", () => ({
  showToast: showToastMock,
  initToast: vi.fn(),
  teardownToast: vi.fn(),
}));
vi.mock("../../../src/features/messaging/content/attachmentCache", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchServerFile: fetchServerFileMock,
}));

import { fileSaver } from "../../../src/platform/desktop/fileSave";
import { shareSheet } from "../../../src/platform/desktop/shareSheet";
import {
  closeActiveLightbox,
  openImageLightbox,
  setServerHost,
} from "../../../src/features/messaging/content/attachments";
import { downloadFile } from "../../../src/features/messaging/content/imageViewer";

const SERVER = "https://chat.example.com/api/v1/files/7f3a";
const BYTES = new Uint8Array([1, 2, 3]);

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function okResponse(): Response {
  return new Response(BYTES, { status: 200 });
}

/** The commands the host was sent, by name. */
function sent(command: string): unknown[][] {
  return invokeMock.mock.calls.filter((c) => c[0] === command);
}

beforeEach(() => {
  hostAndroidApp();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "save_file") return { status: "saved", folder: "downloads" };
    return null;
  });
  fetchServerFileMock.mockImplementation(async () => okResponse());
  setServerHost("chat.example.com");
});

afterEach(() => {
  closeActiveLightbox();
  document.body.replaceChildren();
  clearHost();
  vi.clearAllMocks();
});

describe("the Android file saver", () => {
  it("asks no dialog: the suggested name stands in for the place", async () => {
    await expect(fileSaver.pickSaveLocation("report.pdf")).resolves.toBe("report.pdf");
    expect(dialogMock).not.toHaveBeenCalled();
  });

  it("sends the bytes as the body and the encoded name as a header", async () => {
    invokeMock.mockResolvedValueOnce({ status: "saved", folder: "pictures" });
    await expect(fileSaver.writeFile("café photo.png", BYTES)).resolves.toBe("pictures");
    expect(invokeMock).toHaveBeenCalledWith("save_file", BYTES, {
      headers: { "x-owncord-file-name": "caf%C3%A9%20photo.png" },
    });
    expect(fsWriteMock).not.toHaveBeenCalled();
  });

  it("sends a name with a broken emoji instead of failing the save", async () => {
    await fileSaver.writeFile("a\uD83D.png", BYTES);
    expect(invokeMock).toHaveBeenCalledWith("save_file", BYTES, {
      headers: { "x-owncord-file-name": "a%EF%BF%BD.png" },
    });
  });

  it("reports a save that went to the share sheet (Android 9)", async () => {
    invokeMock.mockResolvedValueOnce({ status: "shared", folder: "downloads" });
    await expect(fileSaver.writeFile("a.zip", BYTES)).resolves.toBe("shared");
  });

  it("rejects when the host refuses the write", async () => {
    invokeMock.mockRejectedValueOnce("save failed: storage refused the file");
    await expect(fileSaver.writeFile("a.zip", BYTES)).rejects.toThrow("storage refused");
  });

  it("keeps the desktop dialog and file write off Android", async () => {
    hostDesktopApp();
    dialogMock.mockResolvedValue("C:\\a.zip");
    await expect(fileSaver.pickSaveLocation("a.zip")).resolves.toBe("C:\\a.zip");
    await expect(fileSaver.writeFile("C:\\a.zip", BYTES)).resolves.toBeNull();
    expect(fsWriteMock).toHaveBeenCalledWith("C:\\a.zip", BYTES);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("the Android share sheet", () => {
  it("is offered only in the Android app", () => {
    expect(shareSheet.available).toBe(true);
    hostDesktopApp();
    expect(shareSheet.available).toBe(false);
  });

  it("shares a file and a piece of text through the host", async () => {
    await shareSheet.shareFile("theme.css", BYTES);
    await shareSheet.shareText("see https://example.com");
    expect(sent("share_file")).toEqual([
      ["share_file", BYTES, { headers: { "x-owncord-file-name": "theme.css" } }],
    ]);
    expect(sent("share_text")).toEqual([["share_text", { text: "see https://example.com" }]]);
  });

  it("refuses on a desktop host without calling it", async () => {
    hostDesktopApp();
    await expect(shareSheet.shareText("x")).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("downloadFile in the Android app", () => {
  it("saves a file to Downloads and says so", async () => {
    await downloadFile(SERVER, "notes.zip");
    expect(sent("save_file")).toHaveLength(1);
    expect(showToastMock).toHaveBeenCalledWith("Saved notes.zip to Downloads", "success");
  });

  it("says Pictures for an image", async () => {
    invokeMock.mockResolvedValueOnce({ status: "saved", folder: "pictures" });
    await downloadFile(SERVER, "photo.png");
    expect(showToastMock).toHaveBeenCalledWith("Saved to Pictures/OwnCord", "success");
  });

  it("says nothing when Android 9 sent the save to the share sheet", async () => {
    invokeMock.mockResolvedValueOnce({ status: "shared", folder: "downloads" });
    await downloadFile(SERVER, "notes.zip");
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("shows the failed toast when the phone refuses the write", async () => {
    invokeMock.mockRejectedValueOnce("save failed: storage refused the file");
    await downloadFile(SERVER, "notes.zip");
    expect(showToastMock).toHaveBeenCalledWith(
      "Download failed for notes.zip \u2014 check logs for details",
      "error",
    );
  });

  it("saves once for two quick taps", async () => {
    let release: (r: Response) => void = () => undefined;
    fetchServerFileMock.mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
    const first = downloadFile(SERVER, "notes.zip");
    const second = downloadFile(SERVER, "notes.zip");
    release(okResponse());
    await Promise.all([first, second]);
    expect(fetchServerFileMock).toHaveBeenCalledTimes(1);
    expect(sent("save_file")).toHaveLength(1);
    // Done: the next tap saves again.
    await downloadFile(SERVER, "notes.zip");
    expect(sent("save_file")).toHaveLength(2);
  });

  it("shares instead of saving when asked to", async () => {
    await downloadFile(SERVER, "notes.zip", "share");
    expect(sent("share_file")).toHaveLength(1);
    expect(sent("save_file")).toHaveLength(0);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("says a refused share failed", async () => {
    invokeMock.mockRejectedValueOnce("share failed: no app can take the file");
    await downloadFile(SERVER, "notes.zip", "share");
    expect(showToastMock).toHaveBeenCalledWith("Couldn't share notes.zip", "error");
  });
});

describe("the lightbox in the Android app", () => {
  const barButtons = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>(".image-lightbox-actions button"),
  ];

  it("shows Save and Share under the image, and no toolbar Download", () => {
    openImageLightbox("blob:http://localhost/abc", "photo.png", { url: SERVER });
    expect(barButtons().map((b) => b.textContent)).toEqual(["Save", "Share"]);
    expect(document.querySelector(".image-lightbox-toolbar [aria-label='Download image']")).toBe(
      null,
    );
  });

  it("Save stores the image and Share opens the sheet", async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === "save_file" ? { status: "saved", folder: "pictures" } : null,
    );
    openImageLightbox("blob:http://localhost/abc", "photo.png", { url: SERVER });
    const [save, share] = barButtons();
    save!.click();
    await flush();
    share!.click();
    await flush();
    expect(sent("save_file")).toEqual([
      ["save_file", BYTES, { headers: { "x-owncord-file-name": "photo.png" } }],
    ]);
    expect(sent("share_file")).toHaveLength(1);
    expect(showToastMock).toHaveBeenCalledWith("Saved to Pictures/OwnCord", "success");
  });

  it("keeps the desktop toolbar on a desktop host", () => {
    hostDesktopApp();
    openImageLightbox("blob:http://localhost/abc", "photo.png", { url: SERVER });
    expect(barButtons()).toHaveLength(0);
    expect(
      document.querySelector(".image-lightbox-toolbar [aria-label='Download image']"),
    ).not.toBe(null);
  });
});
