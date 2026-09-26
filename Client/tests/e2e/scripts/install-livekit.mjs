import { createHash } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
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
await mkdir(dir, { recursive: true });
const archive = resolve(dir, `livekit_${release}_${suffix}`);
const response = await fetch(
  `https://github.com/livekit/livekit/releases/download/v${release}/livekit_${release}_${suffix}`,
  { signal: AbortSignal.timeout(180_000) },
);
if (!response.ok) throw new Error(`LiveKit download: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== digest)
  throw new Error("LiveKit archive checksum mismatch");
await writeFile(archive, bytes);
try {
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
} finally {
  await unlink(archive);
}
