// B9-14: removal, kick (force logout) and ban from a report. Each needs its own
// bit (HP-5: MANAGE_MESSAGES, KICK_MEMBERS, BAN_MEMBERS); the view offers only
// what the reader's role holds, confirms first, says what happened only once
// the server answers, shows a refusal as a refusal, and stops offering an
// action the moment a role change takes its bit away.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApiClientError,
  type ApiClient,
  type ModerationQueueRow,
  type ModerationReportDetail,
} from "@lib/api";
import { Permission } from "@lib/types";
import { authStore } from "@stores/auth.store";
import { resetChannelsStore, setRoles } from "@stores/channels.store";
import { setMembers } from "@stores/members.store";
import type { FeatureViewContext } from "../navigation/destinations";
import { renderModerationCenter } from "./Queue";
import { noteQueueChange } from "./store";

const ME = 7;
const SUBJECT = 4;
const REMOVE = "Remove reported message";
const KICK = "Log out of every session";
const BAN = "Ban member";

interface Call<T> {
  readonly arg: string;
  readonly body?: unknown;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

let lists: Call<ModerationQueueRow[]>[];
let details: Call<ModerationReportDetail>[];
let writes: (Call<unknown> & { readonly op: string })[];
let view: AbortController;

const deferred = <T>(bucket: Call<T>[], arg: string): Promise<T> =>
  new Promise<T>((resolve, reject) => bucket.push({ arg, resolve, reject }));

const api = {
  getModerationQueue: (state: string) => deferred(lists, state),
  getModerationReport: (id: string) => deferred(details, id),
  actOnModerationReport: (id: string, body: unknown) =>
    new Promise((resolve, reject) => writes.push({ op: "act", arg: id, body, resolve, reject })),
} as unknown as ApiClient;

const flush = () => new Promise((r) => setTimeout(r, 0));

const row = (id: string, over: Partial<ModerationQueueRow> = {}): ModerationQueueRow => ({
  id,
  reporter_name: "carol",
  subject_name: "dave",
  target_type: "message",
  target_ref: "55",
  reason: "spam",
  state: "assigned",
  assignee_id: ME,
  outcome: "",
  created_at: "2026-09-05 10:00:00",
  updated_at: "2026-09-05 10:00:00",
  ...over,
});

const held = (id: string, over: Partial<ModerationReportDetail> = {}): ModerationReportDetail => ({
  id,
  reporter_id: 3,
  subject_id: SUBJECT,
  target_type: "message",
  reason: "spam",
  detail: "",
  state: "assigned",
  assignee_id: ME,
  outcome: "",
  created_at: "2026-09-05 10:00:00",
  evidence: [],
  notes: [],
  events: [],
  actions: [],
  ...over,
});

/** The signed-in moderator's role holds exactly `bits`. */
const roleBits = (bits: number) =>
  setRoles([{ id: 3, name: "Moderator", color: null, permissions: bits }]);

const ALL = Permission.MANAGE_MESSAGES | Permission.KICK_MEMBERS | Permission.BAN_MEMBERS;

const acts = (root: HTMLElement) => root.querySelector<HTMLElement>("[data-testid=mod-act]");
const buttons = (root: HTMLElement) =>
  [...(acts(root)?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
const status = (root: HTMLElement) =>
  root.querySelector<HTMLElement>("[data-testid=mod-write-status]")!.textContent;
const alerts = (root: HTMLElement) =>
  [...root.querySelectorAll("[role=alert]")]
    .map((a) => a.textContent)
    .filter(Boolean)
    .join("|");
const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
const reason = (root: HTMLElement) =>
  [...root.querySelectorAll("label")].find(
    (l) => l.textContent === "Reason for a removal, log-out or ban",
  )?.control as HTMLInputElement | undefined;

function press(root: HTMLElement, label: string): void {
  [...acts(root)!.querySelectorAll("button")].find((b) => b.textContent === label)!.click();
}

function answer(label: "Cancel" | "Remove message" | "Log out" | "Ban"): void {
  [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === label)!.click();
}

async function opened(d: ModerationReportDetail): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const ctx: FeatureViewContext = { signal: view.signal, close: () => {}, api };
  renderModerationCenter(root, ctx);
  lists.at(-1)!.resolve([row(d.id, { target_type: d.target_type })]);
  await flush();
  root.querySelector<HTMLButtonElement>(".mod-queue-row")!.click();
  details.at(-1)!.resolve(d);
  await flush();
  return root;
}

beforeEach(() => {
  lists = [];
  details = [];
  writes = [];
  view = new AbortController();
  authStore.setState((prev) => ({
    ...prev,
    token: "tok",
    user: { id: ME, username: "bob", avatar: null, role: "moderator" },
    isAuthenticated: true,
  }));
  setMembers([{ id: ME, username: "bob", avatar: null, role: "moderator", status: "online" }]);
});

afterEach(() => {
  view.abort();
  resetChannelsStore();
  document.body.replaceChildren();
});

describe("what the report offers", () => {
  it.each([
    ["MANAGE_MESSAGES", Permission.MANAGE_MESSAGES, [REMOVE]],
    ["KICK_MEMBERS", Permission.KICK_MEMBERS, [KICK]],
    ["BAN_MEMBERS", Permission.BAN_MEMBERS, [BAN]],
    ["all three", ALL, [REMOVE, KICK, BAN]],
    ["ADMINISTRATOR", Permission.ADMINISTRATOR, [REMOVE, KICK, BAN]],
    ["MODERATE_MEMBERS alone", Permission.MODERATE_MEMBERS, []],
  ])("a role holding %s gets exactly its own actions", async (_, bits, extra) => {
    roleBits(bits);
    const root = await opened(held("r1"));
    expect(buttons(root)).toEqual(["Issue warning", "Time out", ...extra]);
  });

  it("offers none when the role is unknown (pre-ready, or a role the server didn't send)", async () => {
    const root = await opened(held("r1"));
    expect(buttons(root)).toEqual(["Issue warning", "Time out"]);
    expect(reason(root)).toBeUndefined();
  });

  it("offers removal only on a reported message", async () => {
    roleBits(ALL);
    const root = await opened(held("r1", { target_type: "user" }));
    expect(buttons(root)).toEqual(["Issue warning", "Time out", KICK, BAN]);
  });

  it("says the message was already removed instead of offering removal again", async () => {
    roleBits(ALL);
    const root = await opened(
      held("r1", {
        actions: [
          { id: 1, kind: "removal", actor_id: ME, reason: "", created_at: "2026-09-05 10:05:00" },
        ],
      }),
    );
    expect(buttons(root)).toEqual(["Issue warning", "Time out", KICK, BAN]);
    expect(acts(root)!.textContent).toContain("The reported message was already removed.");
    expect(reason(root)).toBeDefined();
  });

  it.each([
    ["another moderator holds it", held("r1", { assignee_id: 9 })],
    ["it is unassigned", held("r1", { state: "open", assignee_id: 0 })],
    ["the reader sent it", held("r1", { reporter_id: ME })],
    ["it is closed", held("r1", { state: "resolved" })],
  ])("offers none when %s", async (_, d) => {
    roleBits(ALL);
    const root = await opened(d);
    expect(buttons(root).filter((b) => [REMOVE, KICK, BAN].includes(b))).toEqual([]);
  });

  it("names the reason field and its hint", async () => {
    roleBits(ALL);
    const root = await opened(held("r1"));
    const input = reason(root)!;
    expect(document.getElementById(input.getAttribute("aria-describedby")!)!.textContent).toBe(
      "Optional, up to 500 characters. Recorded with this report; the member sees the reason for a removal or ban.",
    );
  });
});

describe("confirming", () => {
  it("asks first, with Cancel focused, and Cancel or Escape sends nothing", async () => {
    roleBits(ALL);
    const root = await opened(held("r1"));
    press(root, BAN);
    const d = dialog()!;
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(d.getAttribute("aria-labelledby")!)!.textContent).toBe(
      "Ban this member?",
    );
    expect(document.activeElement!.textContent).toBe("Cancel");
    answer("Cancel");
    expect(dialog()).toBeNull();

    press(root, KICK);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog()).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it.each([
    [REMOVE, "Remove message", "removal", "Message removed for everyone."],
    [KICK, "Log out", "kick", "Logged out of every session. They can sign in again."],
    [BAN, "Ban", "ban", "Member banned. They were disconnected and can't sign in again."],
  ] as const)(
    "%s sends through the report and says so only once the server answers",
    async (label, confirmLabel, kind, done) => {
      roleBits(ALL);
      const root = await opened(held("r1"));
      const input = reason(root)!;
      input.value = "  repeated\tspam ";
      input.dispatchEvent(new Event("input"));
      press(root, label);
      answer(confirmLabel);
      expect(writes.map((w) => [w.op, w.arg, w.body])).toEqual([
        ["act", "r1", { kind, reason: "repeated spam" }],
      ]);
      expect(status(root)).toBe("");

      writes[0]!.resolve(undefined);
      await flush();
      expect(status(root)).toBe(done);
      expect(details.at(-1)!.arg).toBe("r1");
    },
  );
});

describe("the server decides", () => {
  it("shows a refused ban or kick as the server's refusal, and nothing succeeded", async () => {
    roleBits(ALL);
    const root = await opened(held("r1"));
    press(root, KICK);
    answer("Log out");
    writes[0]!.reject(new ApiClientError(403, "FORBIDDEN", "cannot moderate"));
    await flush();
    expect(alerts(root)).toBe(
      "The server refused this action: your role doesn't allow it, or their role isn't below yours.",
    );
    expect(status(root)).toBe("");
  });

  it.each([
    [
      "forbidden: cannot delete this message",
      "The server refused to remove this message: you can't manage messages in its channel.",
    ],
    [
      "forbidden: channel is archived",
      "The server refused to remove this message: its channel is archived.",
    ],
    ["forbidden: blocked", "The server didn't accept this: forbidden: blocked"],
  ])("shows a removal refused with %j as that refusal", async (message, shown) => {
    roleBits(ALL);
    const root = await opened(held("r1"));
    press(root, REMOVE);
    answer("Remove message");
    writes[0]!.reject(new ApiClientError(403, "FORBIDDEN", message));
    await flush();
    expect(alerts(root)).toBe(shown);
    expect(status(root)).toBe("");
  });

  it("claims nothing when the answer never arrives", async () => {
    roleBits(ALL);
    const root = await opened(held("r1"));
    press(root, BAN);
    answer("Ban");
    writes[0]!.reject(new TypeError("network"));
    await flush();
    expect(alerts(root)).toBe(
      "Couldn't confirm this action. Check the history before trying again.",
    );
    expect(status(root)).toBe("");
  });
});

describe("a demoted moderator", () => {
  it("stops being offered an action as soon as the role loses its bit", async () => {
    roleBits(ALL);
    const root = await opened(held("r1"));
    roleBits(Permission.MANAGE_MESSAGES);
    await flush();
    expect(buttons(root)).toEqual(["Issue warning", "Time out", REMOVE]);
  });

  it("does not send a confirmation opened before the demotion", async () => {
    roleBits(ALL);
    const root = await opened(held("r1"));
    press(root, BAN);
    roleBits(0);
    await flush();
    answer("Ban");
    expect(writes).toHaveLength(0);
    expect(buttons(root)).toEqual(["Issue warning", "Time out"]);
  });

  it.each([
    ["kept", ALL, BAN],
    ["taken", Permission.MANAGE_MESSAGES, null],
  ] as const)(
    "puts focus back on the rebuilt report when the bit is %s with the confirm open",
    async (_, bits, back) => {
      roleBits(ALL);
      const root = await opened(held("r1"));
      press(root, BAN);
      roleBits(bits);
      await flush();
      answer("Cancel");
      const active = document.activeElement as HTMLElement;
      expect(root.contains(active)).toBe(true);
      if (back === null) expect(active.tagName).toBe("H3");
      else expect(active.textContent).toBe(back);
    },
  );

  it("keeps a re-read in flight when a role changes, and shows what it answers", async () => {
    roleBits(ALL);
    const root = await opened(held("r1"));
    noteQueueChange();
    await flush();
    lists.at(-1)!.resolve([row("r1", { assignee_id: 9 })]);
    await flush();
    roleBits(ALL | Permission.MANAGE_ROLES);
    await flush();
    details.at(-1)!.resolve(held("r1", { assignee_id: 9 }));
    await flush();
    expect(buttons(root).filter((b) => [REMOVE, KICK, BAN].includes(b))).toEqual([]);
    expect(root.querySelector("[aria-busy=true]")).toBeNull();
  });

  it("follows a change of the reader's own role", async () => {
    setRoles([
      { id: 3, name: "Moderator", color: null, permissions: ALL },
      { id: 4, name: "Member", color: null, permissions: Permission.SEND_MESSAGES },
    ]);
    const root = await opened(held("r1"));
    authStore.setState((prev) => ({ ...prev, user: { ...prev.user!, role: "member" } }));
    await flush();
    expect(buttons(root)).toEqual(["Issue warning", "Time out"]);
  });
});
