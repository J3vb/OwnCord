// The page router: which page is showing, the render of each page, the
// recovery actions of a page that failed to render, and the connect page's
// two hooks (the health refresh and the invite apply) with the invite link
// that arrived before the page mounted. Moved out of main.ts verbatim; the
// free variables (api, ws, the #app element, the profile manager, the 401
// handler) arrive through configureRouter(). Like session.ts it is module
// functions plus one configure call, with no class or factory object: object
// keys survive minification and this runs in the startup chunk. Nothing here
// runs at import time: main.ts calls configureRouter() before anything that
// reads the page, and session.ts and certPrompts.ts reach the router through
// accessors main.ts hands them, so neither imports this module.
//
// This module must not import ./deepLinks: the deep-link handlers import it,
// and the cycle lint forbids the loop.

import { renderFallback, safeMount, type RenderRecovery } from "@lib/text/safeRender";
import type { ApiClient } from "@lib/api";
import type { WsClient } from "@lib/ws";
import type { ProfileManager } from "@lib/presence/profiles";
import { authStore, clearAuth } from "@stores/auth.store";
import { voiceStore, leaveVoiceChannel } from "@stores/voice.store";
import { createLogger } from "@lib/logger";
import { retentionNotice } from "@lib/types";
import { renderConnect } from "./connectRoute";
import { serverInfoFor } from "./serverHealth";
import type { PageId } from "./context";

const log = createLogger("main");

let api: ApiClient;
let ws: WsClient;
let appEl: HTMLElement;
let profileManager: ProfileManager;
let handleUnauthorized: () => void;

// The active page. `currentPage` further down holds the mounted page
// *component*, so the page id needs its own name.
let activePage: PageId = "connect";

// Re-run the connect page's health checks (set while the connect page is
// mounted, cleared otherwise) — refreshes a server's status after its
// certificate is trusted for the first time.
let rerunConnectHealth: (() => void) | null = null;
// Set while the connect page is mounted so an owncord:// deep link can pre-fill
// its register form; the pending value covers links that arrive before it mounts.
let applyInviteToConnectPage: ((code: string, host?: string) => void) | null = null;
let pendingInviteLink: { code: string; host?: string } | null = null;

// Current page component reference for cleanup
let currentPage: { destroy?(): void } | null = null;

// Guards the async MainPage mount below against the destroy-before-mount race:
// a stale mount is discarded when a newer navigation supersedes it.
let navGeneration = 0;

/**
 * Hands the router the services it renders pages with. Call once, before the
 * first render. Positional rather than an options object, for the same reason
 * as configureSession().
 */
export function configureRouter(
  apiClient: ApiClient,
  wsClient: WsClient,
  appElement: HTMLElement,
  profiles: ProfileManager,
  unauthorized: () => void,
): void {
  api = apiClient;
  ws = wsClient;
  appEl = appElement;
  profileManager = profiles;
  handleUnauthorized = unauthorized;
}

/** The id of the page that is showing (or about to). */
export function activePageId(): PageId {
  return activePage;
}

/** Switch pages, re-rendering only when the page actually changed. */
export function navigate(page: PageId): void {
  if (page === activePage) return;
  activePage = page;
  void renderPage(page);
}

/** Render the active page (the first render; the connect branch is synchronous). */
export function renderActive(): Promise<void> {
  return renderPage(activePage);
}

/** Re-run the mounted connect page's health checks; a no-op when it is not mounted. */
export function rerunHealth(): void {
  rerunConnectHealth?.();
}

/** Remember an invite link for the next connect mount to take (null clears it). */
export function queuePendingInvite(link: { code: string; host?: string } | null): void {
  pendingInviteLink = link;
}

/**
 * Hand a pending invite straight to a connect page that is already mounted,
 * and clear it. Tests the hook, not the page id: a connect render that threw
 * leaves the page id on "connect" with no hook. Returns whether it applied.
 */
export function applyInviteNow(code: string, host?: string): boolean {
  if (pendingInviteLink !== null && applyInviteToConnectPage !== null) {
    applyInviteToConnectPage(code, host);
    pendingInviteLink = null;
    return true;
  }
  return false;
}

/** Longest Reload waits for the voice leave before reloading regardless. */
const RELOAD_VOICE_LEAVE_TIMEOUT_MS = 2000;

// The two ways out of a page that failed to render (the fallback's buttons).
// F5 and Ctrl+R are blocked, so without these a failed render is a dead end.
// One reload at a time: a second click while the voice leave is pending must
// wait for it too, not reload straight away.
let reloadInFlight: Promise<void> | null = null;

async function reloadAfterVoiceLeave(): Promise<void> {
  // Leave a call first, the way a logout does, so other members don't see a
  // ghost in the channel and no native call stays live behind the reloaded
  // page. The leave is awaited (the native room's disconnect finishes in the
  // host) but bounded: a hung or failed leave must not strand the user on
  // the fallback.
  if (voiceStore.getState().currentChannelId !== null) {
    ws.send({ type: "voice_leave", payload: {} });
    leaveVoiceChannel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        import("@lib/voice/livekitSession").then(({ leaveVoice }) => leaveVoice(false)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RELOAD_VOICE_LEAVE_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      log.warn("Failed to leave voice before reload", err);
    } finally {
      clearTimeout(timer);
    }
  }
  window.location.reload();
}

export const renderRecovery: RenderRecovery = {
  reload: () => {
    reloadInFlight ??= reloadAfterVoiceLeave().finally(() => {
      reloadInFlight = null;
    });
    return reloadInFlight;
  },
  signOut: () => {
    const wasSignedIn = authStore.getState().isAuthenticated;
    clearAuth();
    // A signed-in logout is navigated by the authStore subscriber (it needs
    // the router still on "main"); only a session that never authenticated
    // has to be sent back here.
    if (wasSignedIn) return;
    if (activePage === "connect") void renderPage("connect");
    else navigate("connect");
  },
};

// Render the appropriate page based on router state
async function renderPage(pageId: PageId): Promise<void> {
  const thisNavigation = ++navGeneration;
  const isCurrentNavigation = (): boolean => thisNavigation === navGeneration;
  log.info("Navigating to page", { pageId });
  // Destroy previous page
  currentPage?.destroy?.();
  currentPage = null;
  appEl.textContent = "";
  // Only valid while the connect page is mounted (re-set in its render branch).
  rerunConnectHealth = null;
  applyInviteToConnectPage = null;

  if (__OWNCORD_WEB__ && globalThis.isSecureContext !== true) {
    // The browser adapters are inert on a page that is not a secure context,
    // so nothing but this notice may render, and nothing reaches the API.
    try {
      const { createInsecureContextPage } = await import("@pages/portal/InsecureContextPage");
      if (!isCurrentNavigation()) return;
      const notice = createInsecureContextPage();
      safeMount(notice, appEl, renderRecovery);
      currentPage = notice;
    } catch (err) {
      log.error("Insecure-context notice failed to load", err);
      if (isCurrentNavigation()) renderFallback(appEl, err, renderRecovery);
    }
  } else if (pageId === "connect") {
    [currentPage, rerunConnectHealth, applyInviteToConnectPage] = renderConnect(
      api,
      profileManager,
      appEl,
      renderRecovery,
      handleUnauthorized,
      () => {
        const pending = pendingInviteLink;
        pendingInviteLink = null;
        return pending;
      },
    );
  } else {
    // MainPage (and the LiveKit voice stack it statically imports) loads
    // lazily so it stays out of the startup path. The chunk is pre-warmed as
    // soon as the WS connect succeeds, so this normally resolves from the
    // module cache.
    try {
      const { createMainPage } = await import("@pages/MainPage");
      // A newer navigation may have superseded this one while the chunk loaded;
      // mounting now would fight the page that navigation rendered.
      if (!isCurrentNavigation()) return;
      const mainPage = createMainPage({
        ws,
        api,
        getRetentionNotice: () => retentionNotice(serverInfoFor(api.getConfig().host ?? "")),
      });
      safeMount(mainPage, appEl, renderRecovery);
      currentPage = mainPage;
    } catch (err) {
      // A rejected chunk import (or a page factory that throws) would leave
      // the cleared window blank. Show the same fallback a failed mount does.
      log.error("Main page failed to load", err);
      if (isCurrentNavigation()) renderFallback(appEl, err, renderRecovery);
    }
  }
}
