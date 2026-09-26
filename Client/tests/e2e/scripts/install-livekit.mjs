import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Fixed release and archive digests: never execute a floating download.
const release = "1.13.5";
// Keyed by `${platform}-${arch}`; the arm64 pair serves B7-17's ARM64
// artifact smoke. Digests match the release's own checksums.txt.
const archives = {
  "linux-x64": [
    "linux_amd64.tar.gz",
    "c020fac437b7cc9b776eef1ad5ea8af77be9acfa07602eca20a3a44930dfbc70",
  ],
  "linux-arm64": [
    "linux_arm64.tar.gz",
    "332015305518765fe05bad74fc3a9d9583e635e7dd130de3c4fc563d69c550f3",
  ],
  "win32-x64": [
    "windows_amd64.zip",
    "3ec7eaa76ef64063bf21f78364733703e0969612cb92ffd60661ed45fa4a8906",
  ],
  "win32-arm64": [
    "windows_arm64.zip",
    "9a0facddf31346f22854a1beaeaaa2c623c165078c54765115b249d771eb0b66",
  ],
};
const target = archives[`${process.platform}-${process.arch}`];
if (!target) throw new Error("Media CI supports Linux/Windows on x64 and arm64");
const [suffix, digest] = target;
const dir = resolve("tests/e2e/.bin");
// The archive is kept, not unlinked, so an actions/cache restore of this one
// directory lets a runner skip the download entirely. It stays in its own
// subdirectory so the cache never sweeps up built installers or test configs.
const cacheDir = resolve(dir, "livekit-cache");
await mkdir(cacheDir, { recursive: true });
const archive = resolve(cacheDir, `livekit_${release}_${suffix}`);
const url = `https://github.com/livekit/livekit/releases/download/v${release}/livekit_${release}_${suffix}`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// A cached archive is trusted only after the same pinned digest check a
// download gets, so a populated cache can never substitute a different binary.
let bytes;
try {
  const cached = await readFile(archive);
  if (sha256(cached) === digest) {
    console.log("LiveKit archive: using cached copy");
    bytes = cached;
  } else {
    console.warn("LiveKit archive: cached copy failed its checksum; re-downloading");
  }
} catch {
  // No cache: the ordinary path.
}

if (bytes === undefined) {
  const attempts = 3;
  for (let attempt = 1; bytes === undefined; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const downloaded = Buffer.from(await response.arrayBuffer());
      const got = sha256(downloaded);
      if (got !== digest) throw new Error(`checksum mismatch (got ${got})`);
      bytes = downloaded;
      console.log(`LiveKit archive: downloaded on attempt ${attempt}/${attempts}`);
    } catch (error) {
      // Bounded and visible: transient GitHub/CDN failures are the re-run tax
      // this retry exists to remove, and each one is printed for the log.
      if (attempt >= attempts)
        throw new Error(`LiveKit download failed after ${attempts} attempts: ${error}`);
      const delay = attempt * 2_000;
      console.warn(
        `LiveKit download attempt ${attempt}/${attempts} failed (${error}); retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  await writeFile(archive, bytes);
}

// Windows ships bsdtar, which also reads zip archives. Named by path: under
// Git Bash a bare `tar` is GNU tar, which reads `D:\...` as a remote host.
const result = spawnSync(
  process.platform === "win32"
    ? resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar",
  [
    "-xf",
    archive,
    "-C",
    dir,
    process.platform === "win32" ? "livekit-server.exe" : "livekit-server",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`LiveKit extraction failed: ${result.status}`);
