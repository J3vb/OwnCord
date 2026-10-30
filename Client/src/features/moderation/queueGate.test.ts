// The age-restricted evidence gate inside the Moderation Center: when its code
// arrives, what it may be mounted into, and what happens when consent is
// recorded or the code never arrives. The gate's own code is replaced by a
// stand-in whose arrival the test controls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, type ApiClient, type ModerationQueueRow } from "@lib/api";
import type { ModerationReportDetail } from "@lib/api";
import { resetChannelsStore, setChannels, setNsfwAcknowledged } from "@stores/channels.store";
import { moderationText as t } from "../../i18n/moderation";
import { nsfwContentBlocked } from "../content-consent/nsfw";
import type { FeatureViewContext } from "../navigation/destinations";
import { renderModerationCenter } from "./Queue";

const SPICY = 9;

interface GateOptions {
  readonly channelName: string;
  readonly focusOnMount?: boolean;
  readonly onAccept: () => Promise<void> | void;
  readonly onCancel: () => void;
}

const gate = vi.hoisted(() => ({
  ready: Promise.resolve<void>(undefined),
  fail: false,
  opts: [] as GateOptions[],
  destroyed: 0,
}));

const gateModule = async () => {
  await gate.ready;
  if (gate.fail) throw new Error("chunk failed");
  return {
    createNsfwGate: (opts: GateOptions) => {
      gate.opts.push(opts);
      const el = document.createElement("div");
      el.dataset.testid = "stub-gate";
      return {
        mount: (slot: HTMLElement) => slot.appendChild(el),
        destroy: () => {
          gate.destroyed++;
          el.remove();
        },
      };
    },
  };
};

interface Call<T> {
  readonly arg: string;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

let lists: Call<ModerationQueueRow[]>[];
let details: Call<ModerationReportDetail>[];
let acks: number[];
let ackResult: Promise<void>;
let view: AbortController;
let release: () => void;

const api = {
  getModerationQueue: (state: string) =>
    new Promise<ModerationQueueRow[]>((resolve, reject) =>
      lists.push({ arg: state, resolve, reject }),
    ),
  getModerationReport: (id: string) =>
    new Promise<ModerationReportDetail>((resolve, reject) =>
      details.push({ arg: id, resolve, reject }),
    ),
  acknowledgeNsfw: (channelId: number) => {
    acks.push(channelId);
    return ackResult;
  },
} as unknown as ApiClient;

const flush = () => new Promise((r) => setTimeout(r, 0));
/** Long enough for the gate's code to have been mounted, had it been going to be. */
const settle = () => new Promise((r) => setTimeout(r, 50));
/** Release the gate's code and wait for it to be mounted. */
async function mounted(): Promise<void> {
  release();
  await vi.waitFor(() => expect(gate.opts.length).toBeGreaterThan(0));
}

const row = (id: string): ModerationQueueRow => ({
  id,
  reporter_name: "carol",
  subject_name: "alice",
  target_type: "message",
  target_ref: "42",
  reason: "spam",
  state: "open",
  assignee_id: 0,
  outcome: "",
  created_at: "2026-09-05 10:00:00",
  updated_at: "2026-09-05 10:00:00",
});

function detail(id: string, over: Partial<ModerationReportDetail> = {}): ModerationReportDetail {
  return {
    id,
    reporter_id: 3,
    subject_id: 4,
    target_type: "message",
    reason: "spam",
    detail: "",
    state: "open",
    assignee_id: 0,
    outcome: "",
    created_at: "2026-09-05 10:00:00",
    evidence: [],
    notes: [],
    events: [],
    actions: [],
    ...over,
  };
}

const withheld = (id: string) =>
  detail(id, {
    channel_id: SPICY,
    evidence: [],
    evidence_withheld: "NSFW_ACKNOWLEDGEMENT_REQUIRED",
  });

function mount(): HTMLElement {
  const outer = document.createElement("div");
  outer.className = "feature-view";
  const root = document.createElement("div");
  outer.append(root);
  document.body.appendChild(outer);
  const ctx: FeatureViewContext = { signal: view.signal, close: () => {}, api };
  renderModerationCenter(root, ctx);
  return root;
}

const q = <T extends Element>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const rowBtn = (root: HTMLElement, id: string) =>
  [...root.querySelectorAll<HTMLButtonElement>(".mod-queue-row")].find(
    (b) => b.dataset.reportId === id,
  )!;
const alerts = (root: HTMLElement) =>
  [...root.querySelectorAll("[role=alert]")]
    .map((a) => a.textContent)
    .filter(Boolean)
    .join("|");

/** Open `id` with its evidence withheld; the gate's code has not arrived yet. */
async function openWithheld(ids: string[] = ["a"]): Promise<HTMLElement> {
  const root = mount();
  lists[0]!.resolve(ids.map(row));
  await flush();
  rowBtn(root, ids[0]!).click();
  details.at(-1)!.resolve(withheld(ids[0]!));
  await flush();
  return root;
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock("@components/NsfwGate", gateModule);
  lists = [];
  details = [];
  acks = [];
  ackResult = Promise.resolve();
  gate.opts = [];
  gate.destroyed = 0;
  gate.fail = false;
  gate.ready = new Promise<void>((r) => {
    release = r;
  });
  view = new AbortController();
  resetChannelsStore();
  setChannels([
    {
      id: SPICY,
      name: "spicy",
      type: "text",
      category: null,
      position: 0,
      nsfw: true,
      nsfw_acknowledged: false,
    },
  ]);
});

afterEach(() => {
  release();
  view.abort();
  resetChannelsStore();
  document.body.replaceChildren();
});

describe("mounting the gate", () => {
  it("mounts it into the report once its code arrives, without asking it to take focus", async () => {
    const root = await openWithheld();
    expect(gate.opts).toHaveLength(0);
    await mounted();
    expect(gate.opts).toHaveLength(1);
    expect(gate.opts[0]!.channelName).toBe("spicy");
    expect(gate.opts[0]!.focusOnMount).toBe(false);
    expect(q(root, ".mod-evidence-gate [data-testid=stub-gate]")).not.toBeNull();
  });

  it("does not mount it for a report that was replaced while its code loaded", async () => {
    const root = await openWithheld(["a", "b"]);
    rowBtn(root, "b").click();
    details.at(-1)!.resolve(detail("b"));
    await flush();
    release();
    await settle();
    expect(gate.opts).toHaveLength(0);
    expect(q(root, "[data-testid=stub-gate]")).toBeNull();
  });

  it("does not mount it after the view is closed", async () => {
    await openWithheld();
    view.abort();
    release();
    await settle();
    expect(gate.opts).toHaveLength(0);
  });

  it("does not mount it into a view that was taken out of the page", async () => {
    const root = await openWithheld();
    root.parentElement!.remove();
    release();
    await settle();
    expect(gate.opts).toHaveLength(0);
    expect(q(root, "[data-testid=stub-gate]")).toBeNull();
  });
});

describe("when the gate's code never arrives", () => {
  it("says the report couldn't load", async () => {
    gate.fail = true;
    const root = await openWithheld();
    release();
    await vi.waitFor(() => expect(alerts(root)).toBe(t("detail.error")));
  });

  it("says nothing for a report that was replaced meanwhile", async () => {
    gate.fail = true;
    const root = await openWithheld(["a", "b"]);
    rowBtn(root, "b").click();
    details.at(-1)!.resolve(detail("b"));
    await flush();
    release();
    await settle();
    expect(alerts(root)).toBe("");
  });

  it("says nothing once the view is closed", async () => {
    gate.fail = true;
    const root = await openWithheld();
    const failure = [...root.querySelectorAll("[role=alert]")][1]!;
    view.abort();
    release();
    await settle();
    expect(failure.textContent).toBe("");
  });
});

describe("recording consent", () => {
  it("records it with the server, then reads the report again with focus and a loading state", async () => {
    const root = await openWithheld();
    await mounted();
    await gate.opts[0]!.onAccept();
    expect(acks).toEqual([SPICY]);
    expect(nsfwContentBlocked(SPICY)).toBe(false);
    expect(details).toHaveLength(2);
    expect(root.textContent).toContain(t("detail.loading"));
    expect(q(root, ".mod-report")).toBeNull();
  });

  it("records nothing locally when the view closed before the server answered", async () => {
    await openWithheld();
    await mounted();
    let answer!: () => void;
    ackResult = new Promise<void>((r) => (answer = r));
    const accepted = gate.opts[0]!.onAccept();
    view.abort();
    answer();
    await accepted;
    expect(acks).toEqual([SPICY]);
    expect(nsfwContentBlocked(SPICY)).toBe(true);
  });

  it("leaves the open report alone when consent for another one was answered late", async () => {
    const root = await openWithheld(["a", "b"]);
    await mounted();
    let answer!: () => void;
    ackResult = new Promise<void>((r) => (answer = r));
    const accepted = gate.opts[0]!.onAccept();
    rowBtn(root, "b").click();
    details.at(-1)!.resolve(detail("b"));
    await flush();
    answer();
    await accepted;
    expect(details.map((c) => c.arg)).toEqual(["a", "b"]);
  });

  it("closes the report when the gate is declined", async () => {
    const root = await openWithheld();
    await mounted();
    gate.opts[0]!.onCancel();
    expect(q(root, ".mod-report")).toBeNull();
    expect(acks).toEqual([]);
    expect(document.activeElement).toBe(rowBtn(root, "a"));
  });

  it("surfaces a server refusal on the acknowledgement as a refused read", async () => {
    const root = await openWithheld();
    await mounted();
    ackResult = Promise.reject(new ApiClientError(403, "FORBIDDEN", "missing MODERATE_MEMBERS"));
    await expect(gate.opts[0]!.onAccept()).rejects.toBeInstanceOf(ApiClientError);
    expect(q(root, ".mod-report")).not.toBeNull();
  });
});

describe("consent withdrawn while the gate is showing", () => {
  it("is not affected by a store change for a channel that stays blocked", async () => {
    const root = await openWithheld();
    await mounted();
    setNsfwAcknowledged(SPICY, false);
    await flush();
    expect(q(root, "[data-testid=stub-gate]")).not.toBeNull();
  });
});
