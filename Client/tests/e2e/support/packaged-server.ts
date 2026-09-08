import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const exec = promisify(execFile);
const version = "1.2.0-alpha.5";
const releasePath = `/J3vb/OwnCord/releases/download/v${version}/`;

/** Build actual old/new main packages. Only the test signing key, upstream
 * HTTP destination and a PID journal differ; verification/swap/restart code
 * is unchanged. No production signing secret or trust bypass is needed. */
export async function preparePackagedServer() {
  const dir = await mkdtemp(join(tmpdir(), "owncord-package-e2e-"));
  const source = resolve("../Server");
  const signer = resolve("tests/e2e/scripts/sign-release.go");
  const binaryName = process.platform === "win32" ? "chatserver.exe" : "chatserver";
  const assetName = process.platform === "win32" ? binaryName : "chatserver-linux-amd64.tar.gz";
  let closed = false;
  let fault: "none" | "corrupt" | "interrupted" = "none";
  const requests: string[] = [];
  const upstream = createServer((request, response) => {
    const path = request.url ?? "";
    requests.push(path);
    void (async () => {
      if (path.startsWith("/repos/")) {
        const names = [
          assetName,
          "chatserver.exe.sig",
          "checksums.sha256",
          "server-update-manifest.json",
          "server-update-manifest.json.sig",
        ];
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            tag_name: `v${version}`,
            body: "E2E signed release",
            html_url: "https://github.com/J3vb/OwnCord/releases",
            assets: names.map((name) => ({
              name,
              browser_download_url: `https://github.com${releasePath}${name}`,
            })),
          }),
        );
        return;
      }
      if (!path.startsWith(releasePath)) {
        response.writeHead(404);
        response.end();
        return;
      }
      const name = path.slice(releasePath.length);
      if (
        ![
          assetName,
          "chatserver.exe.sig",
          "checksums.sha256",
          "server-update-manifest.json",
          "server-update-manifest.json.sig",
        ].includes(name)
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      const data = await readFile(join(dir, name));
      if (name === assetName && fault === "corrupt") {
        response.end(Buffer.from("corrupt package"));
        return;
      }
      if (name === assetName && fault === "interrupted") {
        response.setHeader("Content-Length", data.length);
        response.setHeader("Connection", "close");
        response.write(data.subarray(0, 1024));
        response.end();
        return;
      }
      response.end(data);
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No release fixture port");
  try {
    await exec("go", ["run", signer, dir, "keygen"], { cwd: source });
    const key = await readFile(join(dir, "public.key"), "utf8");
    const updaterPath = join(source, "updater/updater.go");
    const verifyPath = join(source, "updater/verify.go");
    const mainPath = join(source, "main.go");
    const replacements: Record<string, string> = {};
    const overlay = async (path: string, content: string) => {
      const destination = join(dir, `overlay-${Object.keys(replacements).length}.go`);
      await writeFile(destination, content);
      replacements[path] = destination;
    };
    const updater = await readFile(updaterPath, "utf8");
    if (!updater.includes("&http.Client{Timeout: 30 * time.Second}"))
      throw new Error("Updater constructor changed: review test transport overlay");
    await overlay(
      updaterPath,
      updater.replace(
        "&http.Client{Timeout: 30 * time.Second}",
        "&http.Client{Timeout: 30 * time.Second, Transport: e2eReleaseTransport{}}",
      ) +
        `
// Upstream fixture transport, compiled only by this test's Go overlay.
type e2eReleaseTransport struct{}
func (e2eReleaseTransport) RoundTrip(r *http.Request) (*http.Response, error) {
 if r.URL.Host != "api.github.com" && r.URL.Host != "github.com" { return nil, fmt.Errorf("unexpected update host: %s", r.URL.Host) }
 clone := r.Clone(r.Context()); clone.URL.Scheme = "http"; clone.URL.Host = "127.0.0.1:${address.port}"; clone.Host = clone.URL.Host
 return http.DefaultTransport.RoundTrip(clone)
}
`,
    );
    const verify = await readFile(verifyPath, "utf8");
    if (!verify.includes("strings.TrimSpace(serverUpdatePublicKeyText)"))
      throw new Error("Signing key initialization changed");
    await overlay(
      verifyPath,
      verify.replace("strings.TrimSpace(serverUpdatePublicKeyText)", JSON.stringify(key)),
    );
    await overlay(
      mainPath,
      (await readFile(mainPath, "utf8")) +
        `
func init() {
 if path := os.Getenv("OWNCORD_E2E_PID_JOURNAL"); path != "" {
  f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); if err != nil { panic(err) }
  _, err = fmt.Fprintln(f, os.Getpid()); if err != nil { panic(err) }; if err = f.Close(); err != nil { panic(err) }
 }
}
`,
    );
    const overlayPath = join(dir, "overlay.json");
    await writeFile(overlayPath, JSON.stringify({ Replace: replacements }));
    const next = join(dir, binaryName);
    const old = join(dir, `installed-${binaryName}`);
    await exec(
      "go",
      [
        "build",
        "-overlay",
        overlayPath,
        "-ldflags",
        "-X main.version=1.2.0-alpha.4",
        "-o",
        old,
        ".",
      ],
      { cwd: source, timeout: 180_000 },
    );
    await exec(
      "go",
      ["build", "-overlay", overlayPath, "-ldflags", `-X main.version=${version}`, "-o", next, "."],
      { cwd: source, timeout: 180_000 },
    );
    if (process.platform !== "win32")
      await exec("tar", ["-czf", join(dir, assetName), "-C", dir, binaryName]);
    const hash = createHash("sha256")
      .update(await readFile(join(dir, assetName)))
      .digest("hex");
    await writeFile(join(dir, "checksums.sha256"), `${hash}  ${assetName}\n`);
    await writeFile(
      join(dir, "server-update-manifest.json"),
      JSON.stringify({ version: `v${version}`, asset: assetName, sha256: hash, protocol_epoch: 1 }),
    );
    // Linux uses the signed manifest; Windows additionally verifies the executable signature.
    await exec(
      "go",
      [
        "run",
        signer,
        dir,
        "server-update-manifest.json",
        ...(process.platform === "win32" ? ["chatserver.exe"] : []),
      ],
      { cwd: source },
    );
    const journal = join(dir, "pids");
    return {
      binary: old,
      version,
      journal,
      requests,
      env: { ...process.env, OWNCORD_CONTAINER: "0", OWNCORD_E2E_PID_JOURNAL: journal },
      fault(value: typeof fault) {
        fault = value;
      },
      async pids() {
        return (await readFile(journal, "utf8")).trim().split(/\s+/).map(Number);
      },
      async close() {
        if (closed) return;
        closed = true;
        // The replacement is detached by production code. Kill only PIDs
        // recorded by binaries built in this fixture, never by executable name.
        let pids: number[] = [];
        try {
          pids = (await readFile(journal, "utf8")).trim().split(/\s+/).map(Number);
        } catch {
          /* startup failed */
        }
        for (const pid of pids) {
          try {
            if (process.platform === "win32")
              await exec("taskkill", ["/pid", String(pid), "/t", "/f"]);
            else process.kill(-pid, "SIGTERM");
          } catch (error) {
            if (process.platform !== "win32" && (error as NodeJS.ErrnoException).code !== "ESRCH")
              throw error;
          }
        }
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        await rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
      },
    };
  } catch (error) {
    upstream.closeAllConnections();
    upstream.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
