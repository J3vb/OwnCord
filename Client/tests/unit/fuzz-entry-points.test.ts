// Every place the client turns outside bytes into structure is listed here,
// with the property test that drives it, or as a gap, or as trusted input.
// Two scans feed it: JSON.parse and Response.json() calls in src/, keyed by
// "<file name>.<enclosing function>" so a move to another folder keeps the
// row; and Tauri commands that take a string, bytes or a JSON value from the
// webview, keyed by command name. The server's twin of this inventory is
// Server/invariants/fuzz_entry_table.go. The gap lists only shrink.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { listSourceFiles, srcDir } from "../helpers/srcAst";
import { repoRoot } from "../helpers/repoRoot";

interface Covered {
  source: string;
  /** Test files, relative to Client/, holding fast-check properties for it. */
  targets: string[];
}

/** Webview decoders with a property test. */
const clientCovered: Record<string, Covered> = {};

/** Webview decoders of server or user data with no property test yet. */
const clientGaps: Record<string, string> = {
  "ws.handleMessage": "every WebSocket frame from the server",
  "socket.connectErrorCode": "connect errors relayed from the native socket",
  "api.doFetch": "REST responses",
  "api.parseError": "REST error responses",
  "apiDms.getHealth": "server health response",
  "apiDms.getServerInfo": "server info response",
  "profiles.pingHost": "server health response",
  "profiles.importProfiles": "a profile file the user imports",
  "credentials.parseRelayedLogin": "login response relayed by the native side",
  "attachmentCache.requestFileLink": "REST response",
  "externalContent.json": "external-content broker responses",
  "api.parseAttachments": "moderation report attachments from the server",
};
const clientGapCeiling = 12;

/** Decoders of the client's own storage: what this client wrote earlier. */
const clientTrusted: Record<string, string> = {
  "e2eeCrypto.importIdentityKeyPair": "the identity key blob this client stored in the OS keyring",
  "pendingMessages.decode": "this client's pending-message store",
  "preferences.loadStoredJson": "this client's settings",
  "preferences.loadPref": "this client's settings",
  "preferences.readMigratedStringPref": "this client's settings",
  "themes.getActiveThemeName": "this client's settings",
  "themes.restoreAccent": "this client's settings",
  "supportBundle.allowlistedSettings": "this client's settings",
  "osMotion.manualPreference": "this client's settings",
  "audioElements.parseStoredVolume": "this client's settings",
  "credentials.parseCredential": "this client's browser credential store",
  "settings.load": "this client's browser settings",
};

/** Tauri commands whose text the native side parses or acts on, with no fuzz or property target yet. */
const commandGaps: Record<string, string> = {
  save_settings: "JSON value from the webview",
  get_cert_fingerprint: "host",
  store_identity_pin: "host, user id and pin",
  get_identity_pin: "host and user id",
  accept_cert_fingerprint: "host and fingerprint",
  save_credential: "host and credential text",
  load_credential: "host",
  delete_credential: "host",
  save_identity_key: "host and key blob",
  load_identity_key: "host",
  delete_identity_key: "host",
  save_pending_messages: "host and stored message JSON",
  load_pending_messages: "host",
  delete_pending_messages: "host",
  login_with_saved_password: "host and username",
  external_preview: "URL from message content",
  external_image: "URL from message content",
  open_external_url: "URL from message content",
  start_http_proxy: "server host",
  stop_http_proxy: "server host",
  start_livekit_proxy: "server host",
  ws_connect: "server URL",
  ws_send: "outgoing frame text",
  native_voice_connect: "LiveKit URL and token from the server",
  native_voice_set_key: "voice E2EE key material",
  check_client_update: "server URL",
  download_and_install_update: "server URL",
};
const commandGapCeiling = 27;

/** Tauri commands that hand their text on as an opaque id, label or message body. */
const commandPassThrough: Record<string, string> = {
  android_notify: "notification text shown as-is",
  notify_message: "notification text shown as-is",
  share_text: "text handed to the share sheet as-is",
  start_app_audio: "window label and surface name used as lookup keys",
  native_voice_play_sound: "device id used as a lookup key",
  native_voice_set_device: "device id used as a lookup key",
  native_voice_start_camera: "camera id used as a lookup key",
  native_voice_change_camera: "camera id used as a lookup key",
  native_voice_start_camera_preview: "camera id used as a lookup key",
  native_voice_unpublish_camera: "track id used as a lookup key",
  native_voice_start_screen: "screen id used as a lookup key",
  native_voice_change_screen: "screen id used as a lookup key",
  native_voice_unpublish_screen_audio: "track id used as a lookup key",
  native_voice_set_subscribed: "participant and track ids used as lookup keys",
  native_voice_set_video_view: "participant and track ids used as lookup keys",
  native_voice_set_volume: "participant id used as a lookup key",
  native_voice_set_screenshare_volume: "participant id used as a lookup key",
};

/** "<file name>.<function>" for every JSON.parse / Response.json() call in text. */
function webviewDecoders(rel: string, text: string): string[] {
  if (!text.includes("JSON.parse(") && !text.includes(".json()")) return [];
  const module = path.posix.basename(rel).replace(/\.ts$/, "");
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node, fn: string): void => {
    let here = fn;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
      here = node.name.getText();
    } else if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isVariableDeclaration(node.parent)
    ) {
      here = node.parent.name.getText();
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const isParse = callee.getText() === "JSON.parse";
      const isBodyJson = callee.name.text === "json" && node.arguments.length === 0;
      if (isParse || isBodyJson) out.push(`${module}.${here}`);
    }
    ts.forEachChild(node, (child) => visit(child, here));
  };
  visit(sf, "(module)");
  return out;
}

/** Tauri commands in Rust source whose parameters carry text, bytes or JSON. */
function textCommands(source: string): string[] {
  const code = source.replace(/\/\/[^\n]*/g, "");
  const out: string[] = [];
  const re =
    /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;
  for (const m of code.matchAll(re)) {
    const params = m[2]!
      .split(",")
      .filter((p) => !/:\s*(?:tauri::)?(?:AppHandle|State<|Window|WebviewWindow)/.test(p));
    if (params.some((p) => /\bString\b|&str|Vec<u8>|\bValue\b/.test(p))) out.push(m[1]!);
  }
  return out;
}

function rustFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".rs"))
    .map((f) => path.join(dir, f));
}

const clientRoot = path.join(repoRoot, "Client");
const decoders = new Set(
  listSourceFiles().flatMap((rel) =>
    webviewDecoders(rel, readFileSync(path.join(srcDir, rel), "utf8")),
  ),
);
const commands = new Set(
  rustFiles(path.join(clientRoot, "src-tauri", "src")).flatMap((f) =>
    textCommands(readFileSync(f, "utf8")),
  ),
);

function overlaps(...tables: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const table of tables) {
    for (const key of Object.keys(table)) {
      if (seen.has(key)) dup.push(key);
      seen.add(key);
    }
  }
  return dup;
}

describe("fuzz entry-point inventory", () => {
  it("finds parse calls by enclosing function, whatever the folder", () => {
    const src = [
      "export function readFrame(raw: string) { return JSON.parse(raw); }",
      "const load = async (r: Response) => r.json();",
      "class C { m() { return JSON.parse('1'); } }",
      "const notACall = JSON.stringify({});",
    ].join("\n");
    expect(webviewDecoders("lib/net/frames.ts", src)).toEqual([
      "frames.readFrame",
      "frames.load",
      "frames.m",
    ]);
    expect(webviewDecoders("features/frames.ts", src)[0]).toBe("frames.readFrame");
  });

  it("finds Tauri commands that take text and skips ones that do not", () => {
    const rs = [
      "#[tauri::command]",
      "pub fn takes_text(app: AppHandle, url: String) -> Result<(), String> { Ok(()) }",
      "#[tauri::command(async)]",
      "pub async fn takes_bytes(data: Vec<u8>) {}",
      "#[tauri::command]",
      "fn takes_number(state: State<'_, X>, n: u64) {}",
      "// #[tauri::command] fn commented_out(s: String) {}",
    ].join("\n");
    expect(textCommands(rs)).toEqual(["takes_text", "takes_bytes"]);
  });

  it("lists every webview decoder in exactly one table", () => {
    const listed = { ...clientCovered, ...clientGaps, ...clientTrusted };
    expect(overlaps(clientCovered, clientGaps, clientTrusted)).toEqual([]);
    expect([...decoders].filter((k) => !(k in listed)).toSorted()).toEqual([]);
    expect(
      Object.keys(listed)
        .filter((k) => !decoders.has(k))
        .sort(),
    ).toEqual([]);
  });

  it("lists every text-taking Tauri command in exactly one table", () => {
    const listed = { ...commandGaps, ...commandPassThrough };
    expect(overlaps(commandGaps, commandPassThrough)).toEqual([]);
    expect([...commands].filter((k) => !(k in listed)).toSorted()).toEqual([]);
    expect(
      Object.keys(listed)
        .filter((k) => !commands.has(k))
        .sort(),
    ).toEqual([]);
  });

  it("names property targets that exist and use fast-check", () => {
    for (const [key, entry] of Object.entries(clientCovered)) {
      expect(entry.targets.length, key).toBeGreaterThan(0);
      for (const target of entry.targets) {
        const file = path.join(clientRoot, target);
        expect(existsSync(file), `${key}: ${target}`).toBe(true);
        expect(readFileSync(file, "utf8"), `${key}: ${target}`).toMatch(/fc\.(assert|property)/);
      }
    }
  });

  it("only shrinks the gap lists", () => {
    expect(Object.keys(clientGaps).length).toBe(clientGapCeiling);
    expect(Object.keys(commandGaps).length).toBe(commandGapCeiling);
  });
});
