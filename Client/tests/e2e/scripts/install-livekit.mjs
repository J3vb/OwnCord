import { createHash } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Fixed release and archive digests: never execute a floating download.
const release = "1.13.5";
const archives = {
  linux: ["linux_amd64.tar.gz", "c020fac437b7cc9b776eef1ad5ea8af77be9acfa07602eca20a3a44930dfbc70"],
  win32: ["windows_amd64.zip", "3ec7eaa76ef64063bf21f78364733703e0969612cb92ffd60661ed45fa4a8906"],
};
if (process.arch !== "x64" || !archives[process.platform])
  throw new Error("Media CI supports Linux/Windows x64");
const [suffix, digest] = archives[process.platform];
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
  // Windows runners ship bsdtar, which also reads zip archives.
  const result = spawnSync(
    "tar",
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
