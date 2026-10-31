// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// WP 6.10d: the Settings page's "Voice: AFK" card and the AFK badge on the
// Channels page, driven against the real admin scripts in jsdom.
import { describe, it, expect } from "vitest";
import {
  adminHtmlWithBridge,
  bootAdminPanel,
  type FetchCall,
  type PanelReply as Reply,
} from "../helpers/adminPanelFetch";

const BRIDGE = `<script>
window.__test = {
  renderSettings: renderSettings,
  saveSettings: saveSettings,
  saveAfkChannel: saveAfkChannel,
  renderChannels: renderChannels
};
</script>`;
const ADMIN_HTML = adminHtmlWithBridge(BRIDGE);

interface Bridge {
  renderSettings: () => Promise<string>;
  saveSettings: () => Promise<void>;
  saveAfkChannel: () => Promise<void>;
  renderChannels: () => Promise<string>;
}

const CONNECT_VOICE = 0x200;
const READ_MESSAGES = 0x2;
const CHANNELS = [
  { id: 1, name: "general", type: "text", archived: false, afk: false },
  { id: 2, name: "lounge", type: "voice", archived: false, afk: false, voice_max_users: 0 },
  { id: 3, name: "old-voice", type: "voice", archived: true, afk: false },
  { id: 4, name: "quiet", type: "voice", archived: false, afk: false, voice_max_users: 4 },
];
const role = (allow: number, deny: number) => ({
  roles: [
    { role_id: 1, role_name: "Owner", position: 100, permissions: 0x7fffffff, allow: 0, deny: 0 },
    { role_id: 4, role_name: "Member", position: 40, permissions: 0x663, allow, deny },
  ],
  users: [],
});

function boot(calls: FetchCall[], respond: (path: string, method: string) => Reply) {
  return bootAdminPanel<Bridge>(ADMIN_HTML, calls, respond);
}

async function mountSettings(bridge: Bridge, doc: Document): Promise<void> {
  const content = doc.getElementById("content");
  if (!content) throw new Error("expected #content");
  content.innerHTML = await bridge.renderSettings();
}

describe("Server/admin/static — AFK card", () => {
  function responder(opts: { channels: unknown; perms?: unknown; put?: Reply; timeout?: string }) {
    return (path: string, method: string): Reply => {
      if (path === "/settings" && method === "GET") {
        return {
          json: {
            server_name: "T",
            registration_mode: "invite",
            ...(opts.timeout ? { afk_timeout_seconds: opts.timeout } : {}),
          },
        };
      }
      if (path === "/settings" && method === "PATCH") return { json: {} };
      if (path === "/channels")
        return opts.channels ? { json: opts.channels } : { status: 403, json: { error: "no" } };
      if (path === "/roles")
        return {
          json: [
            { id: 1, name: "Owner", position: 100, is_default: false },
            { id: 9, name: "Newcomer", position: 10, is_default: false },
            { id: 4, name: "Member", position: 40, is_default: true },
          ],
        };
      if (/^\/channels\/\d+\/permissions$/.test(path)) return { json: opts.perms ?? role(0, 0) };
      if (path === "/afk-channel") return opts.put ?? { json: { channel_id: null } };
      return { json: {} };
    };
  }

  it("lists non-archived voice channels plus None, with the five timeouts in minutes", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(calls, responder({ channels: CHANNELS }));
    await mountSettings(b.bridge, b.doc);
    const sel = b.doc.getElementById("s-afk_channel") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["None", "lounge", "quiet"]);
    const t = b.doc.getElementById("s-afk_timeout_seconds") as HTMLSelectElement;
    expect([...t.options].map((o) => `${o.value}:${o.textContent}`)).toEqual([
      "60:1 minute",
      "300:5 minutes",
      "900:15 minutes",
      "1800:30 minutes",
      "3600:60 minutes",
    ]);
    expect(t.value).toBe("300");
    expect(b.doc.getElementById("s-afk_channel-desc")?.textContent).toContain("only listen");
    expect(b.doc.getElementById("s-afk_channel-desc")?.textContent).toContain("Only idle members");
  });

  it("round-trips: the stored timeout and AFK channel are preselected, and an unchanged timeout is not resent", async () => {
    const calls: FetchCall[] = [];
    const chans = CHANNELS.map((c) => (c.id === 4 ? { ...c, afk: true, voice_max_users: 0 } : c));
    const b = await boot(calls, responder({ channels: chans, timeout: "900" }));
    await mountSettings(b.bridge, b.doc);
    expect((b.doc.getElementById("s-afk_channel") as HTMLSelectElement).value).toBe("4");
    const t = b.doc.getElementById("s-afk_timeout_seconds") as HTMLSelectElement;
    expect(t.value).toBe("900");

    (b.doc.getElementById("saveSettingsBtn") as HTMLButtonElement).disabled = false;
    await b.bridge.saveSettings();
    expect(calls.find((c) => c.path === "/settings" && c.method === "PATCH")?.body).toBeUndefined();

    t.value = "3600";
    (b.doc.getElementById("saveSettingsBtn") as HTMLButtonElement).disabled = false;
    await b.bridge.saveSettings();
    expect(calls.find((c) => c.path === "/settings" && c.method === "PATCH")?.body).toEqual({
      afk_timeout_seconds: "3600",
    });
  });

  it("saves the channel on its own endpoint and clears it with null", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(calls, responder({ channels: CHANNELS }));
    await mountSettings(b.bridge, b.doc);
    const sel = b.doc.getElementById("s-afk_channel") as HTMLSelectElement;
    sel.value = "2";
    await b.bridge.saveAfkChannel();
    expect(calls.find((c) => c.path === "/afk-channel")?.body).toEqual({ channel_id: 2 });
    expect(b.doc.getElementById("afkChannelState")?.textContent).toBe("Saved");
    sel.value = "";
    await b.bridge.saveAfkChannel();
    expect(calls.filter((c) => c.path === "/afk-channel").at(-1)?.body).toEqual({
      channel_id: null,
    });
    expect(calls.some((c) => c.path === "/settings" && c.method === "PATCH")).toBe(false);
  });

  it("shows a failed channel save inline, reverts the select and leaves the timeout alone", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(
      calls,
      responder({
        channels: CHANNELS,
        put: { status: 404, json: { error: { message: "channel not found" } } },
      }),
    );
    await mountSettings(b.bridge, b.doc);
    const sel = b.doc.getElementById("s-afk_channel") as HTMLSelectElement;
    sel.value = "2";
    await b.bridge.saveAfkChannel();
    expect(b.doc.getElementById("afkChannelState")?.textContent).toMatch(/^Not saved/);
    expect(sel.value).toBe("");
    expect(sel.disabled).toBe(false);
  });

  it("warns when @everyone cannot connect to the AFK channel, and when it has a user limit", async () => {
    const calls: FetchCall[] = [];
    const chans = CHANNELS.map((c) => (c.id === 4 ? { ...c, afk: true } : c));
    const b = await boot(calls, responder({ channels: chans, perms: role(0, CONNECT_VOICE) }));
    await mountSettings(b.bridge, b.doc);
    const warn = b.doc.getElementById("afkWarnings")?.textContent ?? "";
    expect(warn).toContain("cannot join");
    expect(warn).toContain("user limit of 4");
  });

  it("warns when only Read Messages is denied, naming the default role and not a lower custom one", async () => {
    const calls: FetchCall[] = [];
    const chans = CHANNELS.map((c) => (c.id === 2 ? { ...c, afk: true } : c));
    const perms = role(0, READ_MESSAGES);
    perms.roles.push({
      role_id: 9,
      role_name: "Newcomer",
      position: 10,
      permissions: 0x663,
      allow: 0,
      deny: 0,
    });
    const b = await boot(calls, responder({ channels: chans, perms }));
    await mountSettings(b.bridge, b.doc);
    const warn = b.doc.getElementById("afkWarnings")?.textContent ?? "";
    expect(warn).toContain('"Member" cannot join');
    expect(warn).not.toContain("Newcomer");
  });

  it("renders a role name with markup as text", async () => {
    const calls: FetchCall[] = [];
    const chans = CHANNELS.map((c) => (c.id === 2 ? { ...c, afk: true } : c));
    const perms = role(0, CONNECT_VOICE);
    const member = perms.roles[1];
    if (!member) throw new Error("expected a Member role");
    member.role_name = "<img src=x onerror=alert(1)>";
    const b = await boot(calls, responder({ channels: chans, perms }));
    await mountSettings(b.bridge, b.doc);
    expect(b.doc.querySelector("#afkWarnings img")).toBeNull();
    expect(b.doc.getElementById("afkWarnings")?.textContent).toContain("<img src=x");
  });

  it("shows no warning when the default role can connect and there is no limit", async () => {
    const calls: FetchCall[] = [];
    const chans = CHANNELS.map((c) => (c.id === 2 ? { ...c, afk: true } : c));
    const b = await boot(calls, responder({ channels: chans }));
    await mountSettings(b.bridge, b.doc);
    expect(b.doc.getElementById("afkWarnings")?.textContent).toBe("");
  });

  it("disables the channel select when the channel list is not readable", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(calls, responder({ channels: null }));
    await mountSettings(b.bridge, b.doc);
    expect((b.doc.getElementById("s-afk_channel") as HTMLSelectElement).disabled).toBe(true);
    expect(b.doc.getElementById("s-afk_timeout_seconds")).toBeTruthy();
  });

  it("marks the AFK channel with a badge on the Channels page", async () => {
    const calls: FetchCall[] = [];
    const chans = CHANNELS.map((c) => (c.id === 2 ? { ...c, afk: true } : c));
    const b = await boot(calls, responder({ channels: chans }));
    const host = b.doc.createElement("div");
    host.innerHTML = await b.bridge.renderChannels();
    const rows = [...host.querySelectorAll("tr[data-channel]")];
    const badged = rows
      .filter((r) => r.textContent?.includes("AFK"))
      .map((r) => r.getAttribute("data-channel"));
    expect(badged).toEqual(["2"]);
  });
});
