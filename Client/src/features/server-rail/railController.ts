/**
 * The server switcher's state and actions, shared by every renderer: the saved
 * servers, the layout and its saving, the switch and add guards, and the
 * dialogs it opens. A renderer draws from it and hands it DOM events; the
 * controller holds no DOM of its own and opens no menu.
 */

import { Disposable } from "@lib/disposable";
import { createPromptModal, type ModalInstance } from "@lib/ui/modalFactory";
import type { ServerProfile } from "@lib/presence/profiles";
import {
  actionHosts,
  FOLDER_NAME_MAX,
  loadLayout,
  reconcile,
  renameFolder,
  saveLayout,
  type FolderItem,
  type RailLayout,
} from "@lib/prefs/serverRailLayout";
import { setSidebarMode } from "@stores/ui.store";
import { authStore } from "@stores/auth.store";
import { loadServerIcons, pruneServerIcons, SERVER_ICON_CHANGED } from "./serverIcons";
import { serverRailText } from "../../i18n/serverRail";
import { defaultFolderId, describeServer, type ServerLook } from "./serverRailParts";
import type { RailMutations } from "./serverRailMenus";
import { openServerRailJoinModal } from "./ServerRailJoinModal";
import { shouldConfirmServerSwitch } from "./switchConfirmPref";
import { openServerSwitchConfirm } from "./switchConfirmDialog";

export interface RailControllerOptions {
  /** `api.getConfig().host`: the server this session is connected to. */
  readonly currentHost: string;
  readonly loadServers: () => Promise<readonly ServerProfile[]>;
  readonly switchServer: (host: string) => void;
  readonly addServer: () => void;
  /** Whether pasted text is a usable invite; when true it has been handed on. */
  readonly joinInvite: (text: string) => boolean;
  readonly newFolderId?: () => string;
  /** Back to the connected server's channels (a click on its own icon). */
  readonly onShowServer?: () => void;
}

export interface RailController {
  /** The switcher's lifetime: the controller's subscriptions and dialogs, and the parent of every menu. */
  readonly signal: AbortSignal;
  readonly currentHost: string;
  /** For drawing only: the layout reconciled with the saved servers (before they are read, just the current one). */
  readonly layout: () => RailLayout;
  readonly look: (host: string) => ServerLook;
  /** The cached icon's data URL; the map is reloaded before every draw. */
  readonly icon: (host: string) => string | undefined;
  readonly activate: (host: string) => void;
  readonly add: () => void;
  readonly openJoin: () => void;
  /** What the menu builders, drops and Classic's folder toggle use: reconciled, commit, newFolderId, promptRename. */
  readonly mutations: RailMutations;
  /** Stores `draw` (and the renderer's focus fallback for the dialogs), subscribes, draws once and reads the saved servers. */
  readonly start: (draw: () => void, focusFallback?: () => HTMLElement | null) => void;
  /** Reloads the icon map, then calls `draw`: for a renderer's own triggers. */
  readonly redraw: () => void;
  /** Closes the owned dialogs, then disposes. */
  readonly destroy: () => void;
}

export function createRailController(options: RailControllerOptions): RailController {
  const disposable = new Disposable();
  const { signal } = disposable;
  const { currentHost } = options;
  const newFolderId = options.newFolderId ?? defaultFolderId;

  let profiles: readonly ServerProfile[] = [];
  // True once the saved servers were read. Until then the list is a guess, so
  // actions keep every host the stored layout names (actionHosts).
  let serversKnown = false;
  let loading = false;
  let layout: RailLayout = loadLayout();
  // Set by the first switch/add click; the session is torn down right after,
  // so any later click on the same switcher is a stale double-click.
  let leaving = false;
  let confirming = false;
  let draw: (() => void) | null = null;
  let focusFallback: (() => HTMLElement | null) | undefined;
  let icons: ReturnType<typeof loadServerIcons> = new Map();

  // --- Data ---------------------------------------------------------------

  function allHosts(): string[] {
    const hosts = profiles.map((p) => p.host);
    if (currentHost !== "" && !hosts.includes(currentHost)) hosts.push(currentHost);
    return hosts;
  }

  function savedOrNull(): string[] | null {
    return serversKnown ? profiles.map((p) => p.host) : null;
  }

  /** What actions use: before the read, the full stored layout. */
  function reconciled(): RailLayout {
    return reconcile(layout, actionHosts(layout, savedOrNull(), currentHost));
  }

  function look(host: string): ServerLook {
    return describeServer(host, profiles, currentHost);
  }

  function redraw(): void {
    if (draw === null || signal.aborted) return;
    icons = loadServerIcons();
    draw();
  }

  // Saving at once is safe before the read too: the result keeps every host
  // the stored layout names, so no folder or order is dropped, and a read
  // that never succeeds no longer loses the change.
  function commit(next: RailLayout): void {
    layout = reconcile(next, actionHosts(next, savedOrNull(), currentHost));
    saveLayout(layout);
    redraw();
    if (!serversKnown) loadProfiles();
  }

  function loadProfiles(): void {
    if (loading || signal.aborted) return;
    loading = true;
    void options
      .loadServers()
      .then((loaded) => {
        loading = false;
        if (signal.aborted) return;
        profiles = loaded;
        serversKnown = true;
        // The saved list is known, so a removed server's cached icon can go.
        pruneServerIcons([currentHost, ...loaded.map((p) => p.host)]);
        redraw();
        return;
      })
      .catch(() => {
        // The current server still shows; the next layout change tries the
        // read again.
        loading = false;
      });
  }

  // --- Actions ------------------------------------------------------------

  function fallbackOption(): { fallbackFocus?: () => HTMLElement | null } {
    return focusFallback === undefined ? {} : { fallbackFocus: focusFallback };
  }

  function activate(host: string): void {
    if (host === currentHost) {
      if (options.onShowServer !== undefined) options.onShowServer();
      else setSidebarMode("channels");
      return;
    }
    if (leaving) return;
    if (!shouldConfirmServerSwitch()) {
      leaveFor(host);
      return;
    }
    // A second click while the question is up must not stack another.
    if (confirming) return;
    confirming = true;
    openServerSwitchConfirm({
      name: look(host).name,
      onConfirm: () => leaveFor(host),
      onClose: () => {
        confirming = false;
      },
      signal,
      ...fallbackOption(),
    });
  }

  function leaveFor(host: string): void {
    if (leaving) return;
    leaving = true;
    options.switchServer(host);
  }

  function add(): void {
    if (leaving) return;
    leaving = true;
    options.addServer();
  }

  // The switcher's dialogs close with it: a session that ends while one is
  // open must not leave it (and its focus trap) over the connect page.
  const openModals = new Set<ModalInstance>();
  function ownModal(modal: ModalInstance): void {
    for (const m of openModals) if (!m.overlay.isConnected) openModals.delete(m);
    openModals.add(modal);
  }

  function openJoin(): void {
    ownModal(openServerRailJoinModal({ onSubmit: options.joinInvite }));
  }

  function promptRename(folder: FolderItem): void {
    ownModal(
      createPromptModal({
        title: serverRailText("renameFolder"),
        label: serverRailText("renameLabel"),
        initialValue: folder.name,
        maxLength: FOLDER_NAME_MAX,
        testId: "server-rail-rename-input",
        onSubmit: (value) => commit(renameFolder(reconciled(), folder.id, value)),
        ...fallbackOption(),
      }),
    );
  }

  const mutations: RailMutations = { reconciled, commit, newFolderId, promptRename };

  // --- Lifetime -----------------------------------------------------------

  function start(drawFn: () => void, fallback?: () => HTMLElement | null): void {
    if (draw !== null || signal.aborted) return;
    draw = drawFn;
    focusFallback = fallback;
    disposable.onStoreChange(authStore, (s) => s.serverName, redraw);
    // A custom window event, so not through onEvent.
    window.addEventListener(SERVER_ICON_CHANGED, redraw, { signal });
    redraw();
    loadProfiles();
  }

  function destroy(): void {
    for (const modal of openModals) modal.close();
    openModals.clear();
    disposable.destroy();
    draw = null;
  }

  return {
    signal,
    currentHost,
    layout: () => reconcile(layout, allHosts()),
    look,
    icon: (host) => icons.get(host)?.dataUrl,
    activate,
    add,
    openJoin,
    mutations,
    start,
    redraw,
    destroy,
  };
}
