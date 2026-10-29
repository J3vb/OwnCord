// A mounted Appeals view with every request held open, so a test decides when
// and how each read and write answers.
import { type ApiClient, type ModerationAppealDetail, type ModerationAppealRow } from "@lib/api";
import { authStore } from "@stores/auth.store";
import { setMembers } from "@stores/members.store";
import type { FeatureViewContext } from "../../src/features/navigation/destinations";
import { renderAppeals, type AppealsView } from "../../src/features/moderation/AppealQueue";

export const ME = 7;
export const OTHER = 8;
export const APPELLANT = 9;

export interface Call<T> {
  readonly arg: string;
  readonly signal: AbortSignal | undefined;
  readonly body?: unknown;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export const h = {
  lists: [] as Call<ModerationAppealRow[]>[],
  details: [] as Call<ModerationAppealDetail>[],
  writes: [] as (Call<void> & { readonly op: string })[],
  view: new AbortController(),
  denied: 0,
  reports: [] as string[],
};

const held$ = <T>(bucket: Call<T>[], arg: string, signal?: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => bucket.push({ arg, signal, resolve, reject }));

const writeCall = (op: string, arg: string, body?: unknown): Promise<void> =>
  new Promise<void>((resolve, reject) =>
    h.writes.push({ op, arg, signal: undefined, body, resolve, reject }),
  );

const api = {
  getModerationAppeals: (state: string, signal?: AbortSignal) => held$(h.lists, state, signal),
  getModerationAppeal: (id: string, signal?: AbortSignal) => held$(h.details, id, signal),
  assignModerationAppeal: (id: string) => writeCall("assign", id),
  decideModerationAppeal: (id: string, outcome: string, note: string) =>
    writeCall("decide", id, { outcome, note }),
} as unknown as ApiClient;

export const flush = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));

export function row(id: string, over: Partial<ModerationAppealRow> = {}): ModerationAppealRow {
  return {
    id,
    action_id: 11,
    appellant_id: APPELLANT,
    state: "open",
    assignee_id: 0,
    created_at: "2026-09-20 10:00:00",
    decided_at: null,
    ...over,
  };
}

export function detail(
  id: string,
  over: Partial<ModerationAppealDetail> = {},
): ModerationAppealDetail {
  return {
    id,
    action_id: 11,
    appellant_id: APPELLANT,
    body: "Please reconsider.",
    state: "open",
    assignee_id: 0,
    decided_by: 0,
    decision_note: "",
    created_at: "2026-09-20 10:00:00",
    decided_at: null,
    action: {
      id: 11,
      kind: "timeout",
      actor_id: OTHER,
      reason: "flooding",
      created_at: "2026-09-19 10:00:00",
      expires_at: "2099-01-01 00:00:00",
    },
    ...over,
  };
}

export const heldDetail = (id: string, over: Partial<ModerationAppealDetail> = {}) =>
  detail(id, { state: "assigned", assignee_id: ME, ...over });

export interface Mounted {
  readonly root: HTMLElement;
  readonly title: HTMLElement;
  readonly appeals: AppealsView;
}

/** The view mounted the way the Moderation Center does, its first read still open. */
export function mountAppeals(): Mounted {
  const outer = document.createElement("div");
  outer.className = "feature-view";
  const title = document.createElement("h2");
  title.className = "feature-view-title";
  title.tabIndex = -1;
  const root = document.createElement("div");
  outer.append(title, root);
  document.body.appendChild(outer);
  const ctx: FeatureViewContext = { signal: h.view.signal, close: () => {}, api };
  const appeals = renderAppeals(root, ctx, {
    onDenied: () => {
      h.denied++;
    },
    openReport: (id) => {
      h.reports.push(id);
    },
  });
  return { root, title, appeals };
}

export function resetHarness(): void {
  h.lists = [];
  h.details = [];
  h.writes = [];
  h.view = new AbortController();
  h.denied = 0;
  h.reports = [];
  authStore.setState((s) => ({
    ...s,
    user: { id: ME, username: "mod", avatar: null, role: "moderator" },
  }));
  setMembers([
    { id: OTHER, username: "otto", avatar: null, role: "moderator", status: "online" },
    { id: APPELLANT, username: "appy", avatar: null, role: "member", status: "online" },
  ]);
}

export function teardownHarness(): void {
  h.view.abort();
  document.body.replaceChildren();
}

export const q = <T extends Element>(root: ParentNode, sel: string): T | null =>
  root.querySelector<T>(sel);
export const qa = <T extends Element>(root: ParentNode, sel: string): T[] => [
  ...root.querySelectorAll<T>(sel),
];
export const byId = (root: ParentNode, id: string): HTMLElement =>
  q<HTMLElement>(root, `[data-testid=${id}]`)!;
export const rows = (root: ParentNode): HTMLButtonElement[] =>
  qa<HTMLButtonElement>(root, "[data-testid=mod-appeal-row]");
export const text = (root: ParentNode, id: string): string => byId(root, id).textContent;

/** The queue answered with `list`. */
export async function loaded(list: ModerationAppealRow[]): Promise<Mounted> {
  const m = mountAppeals();
  h.lists.at(-1)!.resolve(list);
  await flush();
  return m;
}

/** An appeal opened by its row and answered with `d`. */
export async function opened(
  d: ModerationAppealDetail,
  r: ModerationAppealRow = row(d.id),
): Promise<Mounted> {
  const m = await loaded([r]);
  rows(m.root)[0]!.click();
  h.details.at(-1)!.resolve(d);
  await flush();
  return m;
}

/** The re-read that follows a write: the queue, then the appeal. */
export async function reread(d: ModerationAppealDetail): Promise<void> {
  h.lists.at(-1)!.resolve([row(d.id, { state: d.state, assignee_id: d.assignee_id })]);
  await flush();
  h.details.at(-1)!.resolve(d);
  await flush();
}

export const work = (root: ParentNode): HTMLElement => byId(root, "mod-appeal-work");
export const alertsOf = (root: ParentNode): string =>
  qa(root, "[role=alert]")
    .map((a) => a.textContent)
    .filter(Boolean)
    .join("|");
