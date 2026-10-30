import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isActionableMessage,
  messageActionGates,
} from "../../src/components/message-list/messageActions";
import { setConnectionStatus } from "../../src/stores/ui.store";
import { setActiveTimeout } from "../../src/features/safety/store";
import {
  ME,
  OTHER,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  setDeveloperMode,
  signInAs,
} from "../helpers/message-actions-fixtures";

const own = () => makeMessage({ user: { id: ME, username: "me", avatar: null } });
const other = () => makeMessage({ user: { id: OTHER, username: "alice", avatar: null } });

describe("messageActionGates", () => {
  beforeEach(() => {
    resetGateStores();
    signInAs("member");
    setChannel();
  });
  afterEach(() => {
    resetGateStores();
    localStorage.clear();
  });

  it("own message: edit and delete, no report", () => {
    const g = messageActionGates(own(), makeOpts({ onReportClick: () => undefined }));
    expect(g.edit.shown).toBe(true);
    expect(g.delete.shown).toBe(true);
    expect(g.report.shown).toBe(false);
  });

  it("someone else's message: report (only with the callback), no edit", () => {
    expect(messageActionGates(other(), makeOpts()).report.shown).toBe(false);
    const g = messageActionGates(other(), makeOpts({ onReportClick: () => undefined }));
    expect(g.report.shown).toBe(true);
    expect(g.edit.shown).toBe(false);
  });

  const delOthers: [string, boolean | undefined, "member" | "moderator", boolean][] = [
    ["true wins over a member role", true, "member", true],
    ["false wins over a moderator role", false, "moderator", false],
    ["undefined falls back to a moderator role", undefined, "moderator", true],
    ["undefined falls back to a member role", undefined, "member", false],
  ];
  it.each(delOthers)("canDeleteOthers %s", (_name, bit, role, expected) => {
    signInAs(role);
    setChannel({ canDeleteOthers: bit });
    expect(messageActionGates(other(), makeOpts()).delete.shown).toBe(expected);
  });

  const pins: [string, boolean | undefined, "member" | "moderator", boolean][] = [
    ["true wins over a member role", true, "member", true],
    ["false wins over a moderator role", false, "moderator", false],
    ["undefined falls back to a moderator role", undefined, "moderator", true],
    ["undefined falls back to a member role", undefined, "member", false],
  ];
  it.each(pins)("canPin %s", (_name, bit, role, expected) => {
    signInAs(role);
    setChannel({ canPin: bit });
    expect(messageActionGates(other(), makeOpts()).pin.shown).toBe(expected);
  });

  it("DM: any participant may pin, nobody deletes the other's message, own is deletable", () => {
    setChannel({ canPin: false, canDeleteOthers: true });
    const opts = makeOpts({ channelType: "dm" });
    expect(messageActionGates(other(), opts).pin.shown).toBe(true);
    expect(messageActionGates(other(), opts).delete.shown).toBe(false);
    expect(messageActionGates(own(), opts).delete.shown).toBe(true);
  });

  it("offline: delete stays shown but disabled with the reason; online it is usable", () => {
    expect(messageActionGates(own(), makeOpts()).delete).toMatchObject({
      shown: true,
      disabled: false,
      reason: null,
    });
    setConnectionStatus("reconnecting");
    const g = messageActionGates(own(), makeOpts()).delete;
    expect(g.shown).toBe(true);
    expect(g.disabled).toBe(true);
    expect(g.reason).not.toBeNull();
  });

  it("reactions are locked offline, while timed out and in a can_react=false channel", () => {
    expect(messageActionGates(other(), makeOpts()).react.disabled).toBe(false);
    setChannel({ canReact: false });
    expect(messageActionGates(other(), makeOpts()).react.disabled).toBe(true);
    setChannel({ canReact: true });
    setActiveTimeout(new Date(Date.now() + 3_600_000).toISOString());
    expect(messageActionGates(other(), makeOpts()).react.reason).not.toBeNull();
    setActiveTimeout(null);
    setConnectionStatus("disconnected");
    const g = messageActionGates(other(), makeOpts()).react;
    expect(g.shown).toBe(true);
    expect(g.disabled).toBe(true);
  });

  it("forward needs the callback and an ordinary sent message", () => {
    expect(messageActionGates(other(), makeOpts()).forward.shown).toBe(false);
    const opts = makeOpts({ onForwardClick: () => undefined });
    expect(messageActionGates(other(), opts).forward).toEqual({
      shown: true,
      disabled: false,
      reason: null,
    });
    expect(messageActionGates(makeMessage({ kind: "call" }), opts).forward.shown).toBe(false);
  });

  it("forward is locked while the socket is down", () => {
    const opts = makeOpts({ onForwardClick: () => undefined });
    setConnectionStatus("reconnecting");
    const g = messageActionGates(other(), opts).forward;
    expect(g.shown).toBe(true);
    expect(g.disabled).toBe(true);
    expect(g.reason).not.toBeNull();
    setConnectionStatus("connected");
  });

  it("a forwarded message of mine cannot be edited, though I can delete it", () => {
    const forward = {
      source_channel_id: 5,
      source_message_id: 9,
      source_timestamp: "2025-01-10T09:00:00Z",
    };
    const g = messageActionGates({ ...own(), forward }, makeOpts());
    expect(g.edit.shown).toBe(false);
    expect(g.delete.shown).toBe(true);
  });

  it("copy ID follows the developer-mode preference", () => {
    expect(messageActionGates(other(), makeOpts()).copyId.shown).toBe(false);
    setDeveloperMode(true);
    expect(messageActionGates(other(), makeOpts()).copyId.shown).toBe(true);
    setDeveloperMode(false);
    expect(messageActionGates(other(), makeOpts()).copyId.shown).toBe(false);
  });

  it.each([
    ["deleted", { deleted: true }],
    ["pending", { status: "pending" as const }],
    ["failed", { status: "failed" as const }],
  ])("a %s row offers no actions", (_name, patch) => {
    signInAs("moderator");
    const msg = makeMessage(patch);
    expect(isActionableMessage(msg)).toBe(false);
    const g = messageActionGates(msg, makeOpts({ onReportClick: () => undefined }));
    for (const gate of Object.values(g)) expect(gate.shown).toBe(false);
  });
});
