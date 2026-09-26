// Runs the installed SDK in its own process so an unexpected cleanup rejection
// is observable without contaminating Vitest's global unhandled-error collector.
// Only IPC is controlled: SDK fetch, Response and ReadableStream run unchanged.
import { createRequire } from "node:module";
import { setImmediate as turn } from "node:timers/promises";

const [format, scenario] = process.argv.slice(2);
const sdk =
  format === "cjs"
    ? createRequire(import.meta.url)("@tauri-apps/plugin-http")
    : await import("@tauri-apps/plugin-http");
const unhandled = [];
const reported = [];
process.on("unhandledRejection", (error) => unhandled.push(String(error)));
console.error = (...args) => reported.push(args.map(String).join(" "));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const calls = [];
const requestRid = 11;
const bodyRid = 17;
const invalidBody = `The resource id ${bodyRid} is invalid.`;
const headers = deferred();
const readStarted = deferred();
const lateRead = deferred();
let bodyExists = false;
let readCount = 0;
let waitingForHeaders = false;
const headerScenario = scenario.startsWith("headers-");
const abort = new AbortController();
const encode = (text) => Uint8Array.from([...new TextEncoder().encode(text), 0]);
const cleanupError = scenario.includes("acl")
  ? "http:allow-fetch-cancel-body not allowed"
  : scenario.includes("transport")
    ? "IPC transport disconnected"
    : scenario === "body-wrong-rid"
      ? "The resource id 999 is invalid."
      : undefined;

globalThis.window = {
  __TAURI_INTERNALS__: {
    async invoke(command, args) {
      calls.push({ command: command.replace("plugin:http|", ""), rid: args?.rid });
      switch (command) {
        case "plugin:http|fetch":
          return requestRid;
        case "plugin:http|fetch_send":
          waitingForHeaders = true;
          if (headerScenario) await headers.promise;
          waitingForHeaders = false;
          bodyExists = true;
          return {
            rid: bodyRid,
            status: scenario === "no-content" ? 204 : 200,
            statusText: scenario === "no-content" ? "No Content" : "OK",
            headers: [["x-sdk-probe", "preserved"]],
            url: "https://fixture.invalid/final",
          };
        case "plugin:http|fetch_cancel":
          if (scenario === "headers-cancel-error") throw "IPC request cancellation failed";
          if (scenario === "headers-abort") headers.reject("Request canceled");
          return;
        case "plugin:http|fetch_cancel_body":
          if (cleanupError) throw cleanupError;
          if (!bodyExists) throw invalidBody;
          bodyExists = false;
          return;
        case "plugin:http|fetch_read_body": {
          readCount++;
          if (readCount === 1) return encode(scenario === "normal-eof" ? '{"id":1}' : '{"id":');
          readStarted.resolve();
          const result = scenario === "normal-eof" ? "eof" : await lateRead.promise;
          if (result === "error") throw "response body read failed";
          if (result === "eof" || result === "eof-already-closed") {
            // Rust 2.5.9 closes its response RID on EOF. An in-flight read
            // retains the response even after cancel_body removes that RID.
            if (result !== "eof-already-closed" && !bodyExists) throw invalidBody;
            bodyExists = false;
            return Uint8Array.of(1);
          }
          return encode("1}");
        }
        default:
          throw new Error(`Unexpected IPC command: ${command}`);
      }
    },
  },
};

const outcome = (promise) =>
  promise.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error: String(error) }),
  );
let result;
if (scenario === "pre-aborted") {
  abort.abort();
  result = await outcome(sdk.fetch("http://fixture.invalid", { signal: abort.signal }));
} else if (headerScenario) {
  const request = outcome(sdk.fetch("http://fixture.invalid", { signal: abort.signal }));
  while (!waitingForHeaders) await turn();
  abort.abort();
  // For headers-late, Rust already committed a response before cancellation,
  // but its fetch_send reply has not reached JavaScript yet.
  if (scenario !== "headers-abort") headers.resolve();
  result = await request;
} else {
  const response = await sdk.fetch("http://fixture.invalid", { signal: abort.signal });
  if (scenario === "no-content") {
    result = {
      status: response.status,
      body: response.body,
      url: response.url,
      header: response.clone().headers.get("x-sdk-probe"),
    };
    abort.abort();
  } else if (scenario.startsWith("stream-cancel")) {
    const reader = response.body.getReader();
    await reader.read();
    const pending = outcome(reader.read());
    await readStarted.promise;
    result = await outcome(reader.cancel());
    lateRead.resolve("error");
    await pending;
    abort.abort();
  } else {
    const body = outcome(response.json());
    await readStarted.promise;
    if (scenario === "normal-eof") {
      result = await body;
      result.url = response.url;
      result.header = response.headers.get("x-sdk-probe");
      abort.abort();
    } else if (scenario === "read-error") {
      lateRead.resolve("error");
      result = await body;
      abort.abort();
    } else {
      // Model the opposite EOF race: native EOF removed the RID, but its
      // successful final-chunk IPC response is still travelling to JS.
      if (scenario === "body-eof-race") bodyExists = false;
      abort.abort();
      result = await body;
      lateRead.resolve(
        scenario === "body-eof-race"
          ? "eof-already-closed"
          : scenario === "body-eof"
            ? "eof"
            : scenario === "body-chunk"
              ? "chunk"
              : "error",
      );
    }
  }
}
// Let SDK pull handlers and detached cleanup replies finish, including the
// event-loop turn in which Node reports an unhandled rejection.
await turn();
await turn();
process.stdout.write(JSON.stringify({ result, calls, bodyExists, unhandled, reported }));
