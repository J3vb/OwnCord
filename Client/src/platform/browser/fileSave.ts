// The browser file saver: a save is a download of a blob through
// `<a download>`. The browser owns the destination (its downloads folder, or
// its own prompt), so there is no dialog to pick a location with and no path
// to write to: `pickSaveLocation` hands the suggested name back as the
// "location", and `writeFile` downloads the bytes under that name's last path
// segment. This is the one mismatch with the contract: a caller cannot tell
// where the file went, nor whether the user cancelled the browser's prompt.
import type { FileSaver } from "../contracts/fileSave";

/** How long the blob URL stays valid after the click: long enough for the
 *  browser to start reading it, short enough not to hold the bytes. */
const RELEASE_AFTER_MS = 60_000;
const FALLBACK_NAME = "download";

/** Release timers still waiting; each removes itself when it fires. */
const releases = new Set<ReturnType<typeof setTimeout>>();

function fileName(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return name === "" ? FALLBACK_NAME : name;
}

function releaseLater(url: string): void {
  const timer = setTimeout(() => {
    releases.delete(timer);
    URL.revokeObjectURL(url);
  }, RELEASE_AFTER_MS);
  releases.add(timer);
}

export const fileSaver: FileSaver = {
  async pickSaveLocation(suggestedName: string): Promise<string | null> {
    return suggestedName;
  },
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const url = URL.createObjectURL(new Blob([data.slice()], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName(path);
    link.rel = "noopener";
    link.hidden = true;
    // Some browsers only start the download for a link that is in the page.
    document.body.append(link);
    try {
      link.click();
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    } finally {
      link.remove();
    }
    releaseLater(url);
  },
};
