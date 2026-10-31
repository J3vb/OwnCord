/**
 * The DM profile side panel and the group DM members panel on the main page:
 * opening, closing and keeping them in step with the active DM.
 */
import { showToast } from "@lib/ui/toast";
import { shellText } from "../../i18n/shell";
import { loadPref, savePref } from "@lib/prefs/preferences";
import { getActiveChannel } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import { createNotesContext } from "../../features/profiles/userNotes";
import type { GroupMemberPanelController } from "./GroupMemberPanelController";
import { listeningKey, DM_PROFILE_PREF, buildDmProfileUser } from "./pageShared";
import type { PageState, PageApi } from "./pageState";

export function createDmProfilePanel(st: PageState, _pg: PageApi) {
  /** Run `act` on the group panel controller, loading it first if a group DM
   *  is active (or `force`d by the header toggle). With no controller and no
   *  group on screen there is nothing to sync or close, so nothing loads. */
  function withGroupPanel(act: (ctrl: GroupMemberPanelController) => void, force = false): void {
    if (st.groupPanelCtrl !== null) {
      act(st.groupPanelCtrl);
      return;
    }
    const active = getActiveChannel();
    const groupActive =
      active !== null &&
      active.type === "dm" &&
      dmStore.getState().channels.some((c) => c.channelId === active.id && c.isGroup);
    if (!force && !groupActive) return;
    st.groupPanelLoad ??= import("./GroupMemberPanelController").then(
      ({ createGroupMemberPanelController }) => {
        if (st.tornDown) return;
        st.groupPanelCtrl = createGroupMemberPanelController({
          api: st.api,
          getSlot: () => st.dmProfileSlot,
          getButton: () => st.dmMembersBtn,
          notify: (message) => showToast(message, "error"),
        });
      },
      () => {
        // The chunk could not load; a later group switch or click retries.
        st.groupPanelLoad = null;
      },
    );
    void st.groupPanelLoad.then(() => {
      if (st.groupPanelCtrl !== null) act(st.groupPanelCtrl);
    });
  }

  /** Toggle the DM profile sidebar open/closed for the current DM partner.
   *
   *  The panel's code is loaded on first open (it is opened only by a DM
   *  header click, so it stays out of the eager MainPage chunk). The slot check
   *  and the DM-mode check run synchronously, and the panel mounts once the
   *  import resolves. A panel still loading counts as open, so the last click
   *  wins as it did when the panel mounted synchronously: a second click during
   *  the fetch closes it (the import is then dropped) and a third opens it
   *  again, and only one panel is ever mounted.
   */
  function toggleDmProfile(): void {
    if (st.dmProfileSlot === null) return;

    // If already open (or loading), close it
    if (st.dmProfileSidebar !== null || st.dmProfileLoad !== null) {
      closeDmProfileByUser();
      return;
    }

    // Only open in DM mode
    const active = getActiveChannel();
    if (active === null || active.type !== "dm") return;
    if (openDmProfileFor(active.id, true)) savePref(DM_PROFILE_PREF, true);
  }

  /** A close the user asked for (the X, Escape, the header button): remembered. */
  function closeDmProfileByUser(): void {
    closeDmProfile();
    savePref(DM_PROFILE_PREF, false);
  }

  /** Mirror the panel's state on the header's "Show User Profile" toggle. */
  function syncDmProfileButton(): void {
    st.dmProfileBtn?.setAttribute(
      "aria-pressed",
      String(st.dmProfileSidebar !== null || st.dmProfileLoad !== null),
    );
  }

  /**
   * Make the panel match the active conversation, without touching the saved
   * preference: a 1:1 DM shows it while the preference is on (updated for the
   * new person on a DM-to-DM switch), a group or a server channel hides it.
   */
  function syncDmProfileToActive(): void {
    const active = getActiveChannel();
    if (active !== null && active.type === "dm" && loadPref<boolean>(DM_PROFILE_PREF, true)) {
      // Already showing: a switch to another 1:1 DM repaints the same panel
      // (no slide-in, no focus move) and follows the new person live.
      const next = st.dmProfileSidebar !== null ? buildDmProfileUser(active.id) : null;
      if (st.dmProfileSidebar !== null && next !== null) {
        bindDmProfileLive(active.id, next.id);
        st.dmProfileSidebar.update(next);
        return;
      }
      closeDmProfile();
      // It opened by itself: never take focus from what the user is typing in.
      openDmProfileFor(active.id, false);
      return;
    }
    closeDmProfile();
  }

  /**
   * Keep the panel's status and name live across presence/rename/nickname
   * changes for as long as it stays open on this DM -- otherwise it is painted
   * once from an open-time snapshot and never updated until re-mounted, leaving
   * it disagreeing with the chat header (which ChannelController's
   * refreshDmHeader already keeps live the same way). Re-binding replaces the
   * previous DM's subscriptions; closeDmProfile drops them.
   */
  function bindDmProfileLive(channelId: number, recipientId: number): void {
    st.dmProfileUnsub?.();
    st.dmProfileChannelId = channelId;
    const refresh = (): void => {
      const next = buildDmProfileUser(channelId);
      if (next !== null) st.dmProfileSidebar?.update(next);
    };
    const unsubMembers = membersStore.subscribeSelector(
      (s) =>
        `${s.members.get(recipientId)?.status ?? ""}|${s.members.get(recipientId)?.activity?.name ?? ""}|${listeningKey(s.members.get(recipientId)?.listening)}`,
      refresh,
    );
    // A banner change shows without reopening the panel.
    const unsubBanner = membersStore.subscribeSelector((s) => {
      const m = s.members.get(recipientId);
      return `${m?.banner ?? ""}|${m?.banner_color ?? ""}`;
    }, refresh);
    const unsubDm = dmStore.subscribeSelector(
      (s) => s.channels.find((c) => c.channelId === channelId),
      refresh,
    );
    st.dmProfileUnsub = () => {
      unsubMembers();
      unsubBanner();
      unsubDm();
    };
  }

  /** Who a Block confirm names: the person the panel shows now. */
  function dmProfileBlockName(fallback: string): string {
    const current = buildDmProfileUser(st.dmProfileChannelId);
    return current?.displayName ?? current?.username ?? fallback;
  }

  /** Mount the panel for a 1:1 DM; false (nothing opened) for a group or an unknown DM. */
  function openDmProfileFor(channelId: number, focus: boolean): boolean {
    if (st.dmProfileSlot === null) return false;
    const profileUser = buildDmProfileUser(channelId);
    if (profileUser === null) return false;

    const load = {};
    st.dmProfileLoad = load;
    syncDmProfileButton();
    void import("@components/DmProfileSidebar").then(
      ({ createDmProfileSidebar }) => {
        // A close (or teardown) since the click supersedes this import: drop it.
        if (st.tornDown || st.dmProfileLoad !== load || st.dmProfileSlot === null) return;
        st.dmProfileLoad = null;

        st.dmProfileSidebar = createDmProfileSidebar({
          user: profileUser,
          host: st.apiConfig.host ?? "",
          notes: createNotesContext(st.api, st.apiConfig.host ?? ""),
          focus,
          onClose: () => {
            closeDmProfileByUser();
          },
          onToggleBlock: (userId, block) => {
            void import("../../features/blocks/blockActions").then(
              ({ confirmAndToggleBlock }) =>
                confirmAndToggleBlock(
                  { api: st.api, notify: showToast },
                  userId,
                  // The panel may have moved to another DM since it opened.
                  dmProfileBlockName(profileUser.username),
                  block,
                ),
              () =>
                showToast(
                  shellText(block ? "members.blockFailed" : "members.unblockFailed"),
                  "error",
                ),
            );
          },
        });
        st.dmProfileSidebar.mount(st.dmProfileSlot);
        syncDmProfileButton();

        bindDmProfileLive(channelId, profileUser.id);
      },
      () => {
        // The panel could not load; a later click may retry.
        if (st.dmProfileLoad === load) st.dmProfileLoad = null;
        syncDmProfileButton();
      },
    );
    return true;
  }

  /** Close the DM profile sidebar if open. */
  function closeDmProfile(): void {
    // Supersede any in-flight lazy open, so it cannot mount after this close.
    st.dmProfileLoad = null;
    if (st.dmProfileUnsub !== null) {
      st.dmProfileUnsub();
      st.dmProfileUnsub = null;
    }
    if (st.dmProfileSidebar !== null) {
      st.dmProfileSidebar.destroy?.();
      st.dmProfileSidebar = null;
    }
    syncDmProfileButton();
  }

  return {
    withGroupPanel,
    toggleDmProfile,
    closeDmProfileByUser,
    syncDmProfileButton,
    syncDmProfileToActive,
    bindDmProfileLive,
    dmProfileBlockName,
    openDmProfileFor,
    closeDmProfile,
  };
}
