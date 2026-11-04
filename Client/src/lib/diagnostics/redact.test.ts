import { describe, expect, it } from "vitest";
import { REDACTION_RULES, addCounts, redactText } from "./redact";

// Fake secrets and personal values, each in the forms a log line can carry
// them: plain, inside JSON, JSON-escaped twice, URL-encoded and wrapped onto
// the next line. Every form must come out without the value.
const SECRETS = {
  token: "plantedtok3n5f1cA9",
  password: "hunter2 with spaces",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkIn0.c2lnbmF0dXJlcGxhbnRlZA",
  bearer: "b3arerPlantedValue77",
  cookie: "sid=plantedcookie42; theme=dark",
  kit: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567",
  recoveryCode: "ABCDE-FGHJK",
  sessionHex: "a".repeat(32) + "0123456789abcdef0123456789abcdef",
  email: "someone.planted@example.org",
  ipv4: "203.0.113.77",
  ipv6: "2001:db8:85a3::8a2e:370:7334",
  user: "plantedosuser",
  invite: "f00dfacecafe1234",
  urlPath: "/channels/planted-room/messages",
  urlQuery: "plantedquerysecret",
} as const;

const CORPUS: readonly {
  readonly name: string;
  readonly text: string;
  readonly gone: readonly string[];
}[] = [
  { name: "token pair", text: `refresh token=${SECRETS.token} done`, gone: [SECRETS.token] },
  {
    name: "camelCase token in JSON",
    text: `{"accessToken":"${SECRETS.token}"}`,
    gone: [SECRETS.token],
  },
  {
    name: "password with spaces in JSON",
    text: `{"message":"login","data":{"password":"${SECRETS.password}"}}`,
    gone: [SECRETS.password, "hunter2"],
  },
  {
    name: "password in a JSON-escaped string",
    text: `{"message":"body {\\"password\\":\\"${SECRETS.password}\\"}"}`,
    gone: ["hunter2"],
  },
  {
    name: "token twice escaped",
    text: `"{\\\\\\"token\\\\\\":\\\\\\"${SECRETS.token}\\\\\\"}"`,
    gone: [SECRETS.token],
  },
  { name: "URL-encoded pair", text: `body=token%3D${SECRETS.token}`, gone: [SECRETS.token] },
  { name: "\\u003d pair", text: `"token\\u003d${SECRETS.token}"`, gone: [SECRETS.token] },
  {
    name: "pair wrapped onto the next line",
    text: `password=\n  ${SECRETS.token}`,
    gone: [SECRETS.token],
  },
  { name: "invite code pair", text: `invite_code: ${SECRETS.invite}`, gone: [SECRETS.invite] },
  {
    name: "bare JWT",
    text: `livekit ${SECRETS.jwt} ok`,
    gone: [SECRETS.jwt, "c2lnbmF0dXJlcGxhbnRlZA"],
  },
  {
    name: "bearer header",
    text: `Authorization: Bearer ${SECRETS.bearer}`,
    gone: [SECRETS.bearer],
  },
  {
    name: "bearer wrapped onto the next line",
    text: `sent with Bearer\n${SECRETS.bearer}`,
    gone: [SECRETS.bearer],
  },
  {
    name: "bearer after an escaped newline",
    text: `"auth was Bearer\\n${SECRETS.bearer}"`,
    gone: [SECRETS.bearer],
  },
  {
    name: "authorization header in JSON",
    text: `{"headers":{"Authorization":"Basic ${SECRETS.bearer}"}}`,
    gone: [SECRETS.bearer],
  },
  { name: "cookie header", text: `Cookie: ${SECRETS.cookie}`, gone: ["plantedcookie42"] },
  { name: "recovery kit secret", text: `kit shown ${SECRETS.kit}`, gone: [SECRETS.kit] },
  {
    name: "recovery code",
    text: `code ${SECRETS.recoveryCode} used`,
    gone: [SECRETS.recoveryCode],
  },
  {
    name: "session token as hex",
    text: `session ${SECRETS.sessionHex}`,
    gone: [SECRETS.sessionHex],
  },
  {
    name: "URL with path, query and user info",
    text: `GET https://alice:${SECRETS.token}@chat.example.org:8443${SECRETS.urlPath}?q=${SECRETS.urlQuery}#x failed`,
    gone: [SECRETS.token, SECRETS.urlPath, SECRETS.urlQuery, "alice"],
  },
  {
    name: "JSON-escaped URL",
    text: `{"u":"wss:\\/\\/chat.example.org\\/ws?token=${SECRETS.token}"}`,
    gone: [SECRETS.token, "\\/ws"],
  },
  {
    name: "invite deep link",
    text: `opened owncord://invite/${SECRETS.invite}?host=chat.example.org`,
    gone: [SECRETS.invite],
  },
  { name: "URL with an IP host", text: `https://${SECRETS.ipv4}:8443/api`, gone: [SECRETS.ipv4] },
  { name: "email", text: `user ${SECRETS.email} signed in`, gone: [SECRETS.email] },
  { name: "IPv4", text: `peer ${SECRETS.ipv4}:50000 connected`, gone: [SECRETS.ipv4] },
  { name: "IPv4 in JSON", text: `{"ip":"${SECRETS.ipv4}"}`, gone: [SECRETS.ipv4] },
  { name: "IPv6", text: `candidate ${SECRETS.ipv6} udp`, gone: [SECRETS.ipv6, "8a2e:370:7334"] },
  { name: "IPv6 in brackets", text: `https://[${SECRETS.ipv6}]:443/x`, gone: ["8a2e"] },
  { name: "Linux home", text: `/home/${SECRETS.user}/.local/share/owncord`, gone: [SECRETS.user] },
  { name: "Fedora Atomic home", text: `/var/home/${SECRETS.user}/x`, gone: [SECRETS.user] },
  { name: "macOS home", text: `/Users/${SECRETS.user}/Library`, gone: [SECRETS.user] },
  { name: "Windows home", text: `C:\\Users\\${SECRETS.user}\\AppData`, gone: [SECRETS.user] },
  {
    name: "Windows home in JSON",
    text: `{"path":"C:\\\\Users\\\\${SECRETS.user}\\\\AppData"}`,
    gone: [SECRETS.user],
  },
  { name: "Windows home with slashes", text: `c:/users/${SECRETS.user}/x`, gone: [SECRETS.user] },
  {
    name: "Windows home with a space",
    text: `C:\\Users\\Planted ${SECRETS.user}\\AppData\\Local`,
    gone: [SECRETS.user, "Planted"],
  },
  {
    name: "macOS home with a space",
    text: `/Users/Planted ${SECRETS.user}/Library`,
    gone: [SECRETS.user, "Planted"],
  },
  {
    name: "password holding an escaped quote",
    text: `{"password":"pa\\"ss ${SECRETS.token}"}`,
    gone: [SECRETS.token, "ss "],
  },
  {
    name: "password holding an apostrophe",
    text: `password="it's ${SECRETS.token}"`,
    gone: [SECRETS.token],
  },
  {
    name: "query after a JSON-escaped ampersand",
    text: `"https://a.example/x?y=1\\u0026token=${SECRETS.token}"`,
    gone: [SECRETS.token],
  },
];

describe("redactText corpus", () => {
  for (const sample of CORPUS) {
    it(`removes ${sample.name}`, () => {
      const out = redactText(sample.text);
      for (const value of sample.gone) expect(out.text).not.toContain(value);
      expect(Object.values(out.counts).reduce((n, c) => n + c, 0)).toBeGreaterThan(0);
    });
  }

  it("leaves no planted value in the whole corpus joined as one log", () => {
    const out = redactText(CORPUS.map((s) => s.text).join("\n"));
    for (const value of Object.values(SECRETS)) expect(out.text).not.toContain(value);
  });
});

describe("redactText keeps what a reader needs", () => {
  const KEPT = [
    "[2026-10-02][16:27:19][owncord_client_lib::crash_log][ERROR] [crash] fatal signal SIGSEGV (11) on thread 'owncord-screen'",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.80",
    "WebView2 130.0.2849.80",
    "connected to wss://chat.example.org:8443",
    "local proxy on 127.0.0.1:43210 and [::1]",
    "unhandled exception 0xC0000005 (access violation) in nvwgf2umx.dll+0x1A2B3C",
    "build 0123456789abcdef0123456789abcdef01234567",
    '{"t":1730000000000,"code":"ws.closed","generation":3,"close_code":1006}',
    '{"rememberPassword": true, "autoConnect": false}',
    "at render (https://tauri.localhost/assets/index-abc123.js:1:234)",
    "uptime 00:12:30 and 16:27:19",
    "Basic authentication failed, using basic configuration now",
    "Bearer authentication is required",
    "Unknown key: foo, Hotkey: Ctrl+K, tokens: 5 used",
  ];
  for (const line of KEPT) {
    it(`keeps ${line.slice(0, 48)}`, () => {
      expect(redactText(line)).toEqual({ text: line, counts: {} });
    });
  }

  it("cuts a URL to its scheme and host", () => {
    expect(redactText("see https://chat.example.org/a/b?c=d#e now").text).toBe(
      "see https://chat.example.org now",
    );
  });

  it("keeps the punctuation that closes a URL in prose", () => {
    expect(redactText("(see https://example.com/a/b), then").text).toBe(
      "(see https://example.com), then",
    );
  });

  it("scans long runs in linear time", () => {
    const started = performance.now();
    for (const run of [
      "x".repeat(400_000),
      "ab.cd-".repeat(60_000),
      "a.".repeat(200_000),
      "1.".repeat(200_000),
    ]) {
      redactText(run);
    }
    expect(performance.now() - started).toBeLessThan(3_000);
  }, 20_000);

  it("drops only the query from an app asset URL", () => {
    expect(redactText("https://tauri.localhost/assets/x.js?v=1").text).toBe(
      "https://tauri.localhost/assets/x.js",
    );
  });

  it("writes a home folder as ~", () => {
    expect(redactText("/home/someone/.config/owncord/x.log").text).toBe("~/.config/owncord/x.log");
  });

  it("keeps the JSON it is given valid", () => {
    const value = {
      url: `https://h.example/p?token=${SECRETS.token}`,
      nested: { password: SECRETS.password, note: `from ${SECRETS.ipv4} as ${SECRETS.email}` },
      escaped: `{"token":"${SECRETS.token}"}`,
      path: `C:\\Users\\${SECRETS.user}\\x`,
    };
    for (const text of [
      JSON.stringify(value),
      JSON.stringify(value, null, 2),
      JSON.stringify(JSON.stringify(value)),
    ]) {
      const out = redactText(text).text;
      expect(() => JSON.parse(out)).not.toThrow();
      for (const secret of [SECRETS.token, "hunter2", SECRETS.ipv4, SECRETS.email, SECRETS.user]) {
        expect(out).not.toContain(secret);
      }
    }
  });

  it("counts each hit under its rule", () => {
    const out = redactText(`a ${SECRETS.email} b ${SECRETS.email} c ${SECRETS.ipv4}`);
    expect(out.counts).toEqual({ email: 2, ipv4: 1 });
    for (const rule of Object.keys(out.counts)) expect(REDACTION_RULES).toContain(rule);
  });

  it("adds count records", () => {
    expect(addCounts({ email: 1 }, { email: 2, url: 1 })).toEqual({ email: 3, url: 1 });
  });
});
