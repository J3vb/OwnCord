import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export async function freePort(): Promise<number> {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port allocated");
  await new Promise<void>((resolve, reject) => listener.close((e) => (e ? reject(e) : resolve())));
  return address.port;
}

export function startProcess(command: string, args: string[], cwd: string, env = process.env) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: "pipe",
  });
  let output = "";
  let error: Error | undefined;
  child.on("error", (e) => {
    error = e;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-256_000);
    });
  }
  return { child, log: () => output, error: () => error };
}

export async function waitForHttp(
  url: string,
  processInfo: ReturnType<typeof startProcess>,
  timeout = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (
      processInfo.error() ||
      processInfo.child.exitCode !== null ||
      processInfo.child.signalCode !== null
    ) {
      throw new Error(
        `Process exited before ${url} was ready: ${processInfo.error() ?? ""}\n${processInfo.log()}`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      /* Not listening yet. */
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}\n${processInfo.log()}`);
}

/** Terminate only the process tree this fixture started, and wait for exit. */
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => true);
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    await once(killer, "exit");
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  }
  if (await Promise.race([exited, delay(10_000, false, { ref: false })])) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  }
  if (!(await Promise.race([exited, delay(5000, false, { ref: false })])))
    throw new Error(`Process ${child.pid} did not exit`);
}

/** OS-level observations of children owned by the given test server. */
export async function childPids(parent: number): Promise<number[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const result =
    process.platform === "win32"
      ? await exec("powershell", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parent}' | Select-Object -ExpandProperty ProcessId`,
        ])
      : await exec("ps", ["-o", "pid=", "--ppid", String(parent)]).catch((error) => {
          if (error.code === 1) return { stdout: "" };
          throw error;
        });
  return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
