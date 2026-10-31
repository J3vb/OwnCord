import { JSDOM } from "jsdom";
import { loadPanelWithFetch, scriptedPanelFetch, settlePanel } from "./adminPanelFetch";
import { ADMIN_HTML_SOURCE } from "./serverAdminStaticPanelMocks";

// The panel's scripts are classic scripts: their top-level declarations live in
// the window's shared script scope but never land on `window`. A second script
// bridges the bindings these tests drive onto a test-only global.
export const BRIDGE = `<script>
window.__test = {
  get state(){return state},
  utcDate: utcDate,
  effectiveBan: effectiveBan,
  myPosition: myPosition,
  renderUsers: renderUsers,
  renderInvites: renderInvites,
  openInviteRedemptions: openInviteRedemptions,
  renderAudit: renderAudit,
  renderDashboard: renderDashboard,
  auditSentence: auditSentence,
  actionLabels: ACTION_LABEL,
  renderTokens: renderTokens,
  downloadArchive: downloadArchive,
  openRoleModal: openRoleModal,
  renderRetention: renderRetention,
  saveChannelRetention: saveChannelRetention,
  clearChannelRetention: clearChannelRetention,
  openApplyRetention: openApplyRetention,
  closeModal: closeModal,
  applyRetention: applyRetention,
  navigateTo: navigateTo,
  enterApp: enterApp,
  nav: NAV,
  wiz: wiz,
  wizStepCount: WIZ_STEP_COUNT,
  renderWizard: renderWizard,
  renderWhatsNew: renderWhatsNew,
  actions: ACTIONS
};
</script>`;

export const ADMIN_HTML = ADMIN_HTML_SOURCE.replace("</body>", `${BRIDGE}\n</body>`);

export interface FetchCall {
  method: string;
  url: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/* eslint-disable  @typescript-eslint/no-explicit-any */
export interface Bridge {
  state: any;
  utcDate: (s: string) => Date;
  effectiveBan: (u: any) => boolean;
  myPosition: () => number;
  renderUsers: () => Promise<string>;
  renderInvites: () => Promise<string>;
  openInviteRedemptions: (code: string, uses?: number) => Promise<void>;
  renderAudit: () => Promise<string>;
  renderDashboard: () => Promise<string>;
  auditSentence: (e: any) => string;
  actionLabels: Record<string, string>;
  renderTokens: () => Promise<string>;
  downloadArchive: () => Promise<void>;
  openRoleModal: (id: number | null) => void;
  renderRetention: () => Promise<string>;
  saveChannelRetention: (id: number) => Promise<void>;
  clearChannelRetention: (id: number) => Promise<void>;
  openApplyRetention: () => Promise<void>;
  closeModal: () => void;
  applyRetention: () => Promise<void>;
  navigateTo: (id: string) => void;
  enterApp: () => Promise<void>;
  nav: { id?: string; label?: string; allowed?: () => boolean }[];
  wiz: { step: number };
  wizStepCount: number;
  renderWizard: () => void;
  renderWhatsNew: () => Promise<string>;
  actions: Record<string, unknown>;
}

export type Responder = (
  path: string,
  method: string,
) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

export const proposedPreview = {
  token: "signed-preview",
  revision: "revision-1",
  observed_at: "2026-09-23T12:30:00Z",
  would_delete: 42,
  affected_channels: 1,
  protected_pinned: 2,
  protected_indefinite: 3,
  protected_direct_messages: 4,
  channels: [
    {
      channel_id: 7,
      channel_name: "archive <script>",
      days: 30,
      source: "server",
      would_delete: 42,
      protected_pinned: 2,
      protected_indefinite: 0,
    },
  ],
};

export const ADMINISTRATOR = 0x40000000;

export function loadAdminPanel(calls: FetchCall[], respond: Responder): JSDOM {
  return loadPanelWithFetch(
    ADMIN_HTML,
    scriptedPanelFetch(
      (call) => calls.push(call),
      (path, method) =>
        path === "/setup/status" ? { json: { needs_setup: false } } : respond(path, method),
    ),
  );
}

export async function boot(
  calls: FetchCall[],
  respond: Responder,
): Promise<{ dom: JSDOM; bridge: Bridge }> {
  const dom = loadAdminPanel(calls, respond);
  const bridge = await settlePanel<Bridge>(dom);
  calls.length = 0;
  return { dom, bridge };
}

/** `boot`, then signs in as an administrator who outranks everyone. */
export async function bootAsAdmin(
  calls: FetchCall[],
  respond: Responder,
): Promise<{ dom: JSDOM; bridge: Bridge }> {
  const booted = await boot(calls, respond);
  booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };
  return booted;
}

/** What core.js showApp does after sign-in. jsdom, like a browser, only
 * focuses what is displayed, and boot() leaves the shell hidden. */
export function showShell(dom: JSDOM): void {
  dom.window.document.getElementById("adminShell")!.classList.remove("hidden");
}

// Sign-in is a real <form>: submit it the way Enter or the button does, then
// let the handler's fetch chain (mocked, so microtasks only) run out.
export async function submitForm(doc: Document, id: string): Promise<void> {
  (doc.getElementById(id) as HTMLFormElement).requestSubmit();
  const win = doc.defaultView!;
  for (let i = 0; i < 5; i++) await new Promise((resolve) => win.setTimeout(resolve, 0));
}

export const defaultRespond: Responder = () => ({ json: {} });
