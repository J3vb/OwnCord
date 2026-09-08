import { request, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { freePort, freeUdpPort, startProcess, stopProcess, waitForHttp } from "./process";

export const TEST_PASSWORD = "OwnCord-E2E-pass-123!";

/** No database shortcuts: setup, accounts and channels use production HTTP routes. */
export async function startTestServer(
  options: {
    tls?: boolean;
    livekit?: boolean;
    seed?: boolean;
    binary?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const livekit = process.env.OWNCORD_E2E_LIVEKIT_BINARY;
  if (options.livekit && !livekit)
    throw new Error("OWNCORD_E2E_LIVEKIT_BINARY is required for media tests");
  const directory = await mkdtemp(join(tmpdir(), "owncord-e2e-"));
  const port = await freePort();
  const livekitPort = await freePort();
  const rtcPort = await freePort();
  const rtcUdpPort = options.livekit ? await freeUdpPort() : 0;
  const dataDir = join(directory, "data");
  await mkdir(dataDir);
  const binary = resolve(
    options.binary ??
      process.env.OWNCORD_E2E_SERVER_BINARY ??
      `tests/e2e/.bin/chatserver${process.platform === "win32" ? ".exe" : ""}`,
  );
  if (options.livekit) {
    await writeFile(
      join(dataDir, "livekit.yaml"),
      `port: ${livekitPort}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${rtcPort}\n  udp_port: ${rtcUdpPort}\n  use_external_ip: false\n  node_ip: 127.0.0.1\n  enable_loopback_candidate: true\nkeys:\n  e2e-key: e2e-secret-at-least-32-characters-long\n`,
    );
  }
  const config = {
    server: {
      port,
      data_dir: dataDir,
      restart_mode: "spawn",
      allowed_origins: [
        "http://localhost:1420",
        "http://localhost:4173",
        "http://127.0.0.1:1420",
        "http://tauri.localhost",
        "tauri://localhost",
      ],
    },
    database: { path: join(dataDir, "chatserver.db") },
    tls: { mode: options.tls ? "self_signed" : "off" },
    voice: {
      auto_download_livekit: false,
      livekit_binary: options.livekit ? resolve(livekit!) : "",
      livekit_url: `ws://127.0.0.1:${livekitPort}`,
      livekit_api_key: "e2e-key",
      livekit_api_secret: "e2e-secret-at-least-32-characters-long",
    },
  };
  // JSON is valid YAML; avoids platform-specific escaping of temporary paths.
  await writeFile(join(directory, "config.yaml"), JSON.stringify(config));
  const origin = `${options.tls ? "https" : "http"}://127.0.0.1:${port}`;
  let running = startProcess(binary, [], directory, options.env ?? process.env);
  const logs: string[] = [];
  const http = await request.newContext({ ignoreHTTPSErrors: !!options.tls, timeout: 15_000 });
  const ready = async () => {
    await expect
      .poll(
        async () => {
          if (running.error()) throw running.error();
          try {
            return (await http.get(`${origin}/health`, { timeout: 1000 })).status();
          } catch {
            return 0;
          }
        },
        { timeout: 60_000, message: `OwnCord did not start at ${origin}` },
      )
      .toBe(200);
  };
  const api = async (
    path: string,
    body?: unknown,
    token?: string,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await http.fetch(`${origin}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      data: body,
    });
    const text = await response.text();
    if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  try {
    // TLS native runners use Playwright's scoped request context for setup.
    await ready();
    if (options.livekit) await waitForHttp(`http://127.0.0.1:${livekitPort}`, running);
    let owner: { token: string; invite_code: string; user_id: number } | undefined;
    if (options.seed !== false) {
      owner = await api("/admin/api/setup", { username: "alice", password: TEST_PASSWORD });
      await api("/api/v1/auth/register", {
        username: "bob",
        password: TEST_PASSWORD,
        invite_code: owner!.invite_code,
      });
      await api("/admin/api/channels", { name: "voice-one", type: "voice" }, owner!.token);
      await api("/admin/api/channels", { name: "voice-two", type: "voice" }, owner!.token);
    }
    return {
      origin,
      exited: () => running.child.exitCode !== null || running.child.signalCode !== null,
      port,
      livekitPort,
      directory,
      api,
      owner,
      log: () => [...logs, running.log()].join("\n"),
      async stop() {
        await stopProcess(running.child);
        logs.push(running.log());
      },
      async restart() {
        await stopProcess(running.child);
        logs.push(running.log());
        running = startProcess(binary, [], directory, options.env ?? process.env);
        await ready();
        if (options.livekit) await waitForHttp(`http://127.0.0.1:${livekitPort}`, running);
      },
      async close() {
        await stopProcess(running.child);
        await http.dispose();
        await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      },
    };
  } catch (error) {
    await http.dispose();
    await stopProcess(running.child);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    throw new Error(`${String(error)}\n${running.log()}`);
  }
}

export type TestServer = Awaited<ReturnType<typeof startTestServer>>;
