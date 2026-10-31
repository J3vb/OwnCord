/**
 * The screens that open on first use (O-6a) stay out of the main-page chunk:
 * no always-loaded module imports them statically. A value import of one of
 * these files drags it back into MainPage; a type import and a dynamic
 * `import()` do not.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../../src");

const LAZY = [
  "QuickSwitcher",
  "InviteManager",
  "PinnedMessages",
  "SearchOverlay",
  "CreateChannelModal",
  "EmojiPicker",
  "GifPicker",
  "VoiceWidget",
  "volumeMenu",
  "VideoGrid",
] as const;

// Modules in the main-page chunk that used to import them.
const EAGER_SITES = [
  "pages/main-page/OverlayManagers.ts",
  "pages/main-page/SidebarArea.ts",
  "pages/main-page/sidebar-area/sidebarChannels.ts",
  "pages/main-page/sidebar-area/sidebarContent.ts",
  "pages/main-page/sidebar-area/sidebarDms.ts",
  "pages/main-page/sidebar-area/sidebarHeader.ts",
  "pages/main-page/sidebar-area/sidebarShared.ts",
  "pages/main-page/sidebar-area/sidebarVoiceSwitch.ts",
  "pages/main-page/ReactionController.ts",
  "components/MessageInput.ts",
  "components/message-input/inputAttachments.ts",
  "components/message-input/inputAutocomplete.ts",
  "components/message-input/inputComposer.ts",
  "components/message-input/inputDraft.ts",
  "components/message-input/inputSend.ts",
  "components/message-input/inputShared.ts",
  "components/SelfProfileCard.ts",
  "components/EditChannelModal.ts",
  "components/message-list/quickReactions.ts",
  "pages/MainPage.ts",
  "pages/main-page/dmCalls.ts",
  "pages/main-page/dmProfilePanel.ts",
  "pages/main-page/pageMountCalls.ts",
  "pages/main-page/pageMountSettings.ts",
  "pages/main-page/pageMountShell.ts",
  "pages/main-page/pagePresence.ts",
  "pages/main-page/pageShared.ts",
  "components/DmCallPanel.ts",
  "components/DmCallViewModel.ts",
  "components/dm-call/dmCallRender.ts",
  "components/dm-call/dmCallVerify.ts",
  "components/ChannelSidebar.ts",
  "pages/main-page/ChatArea.ts",
] as const;

describe("lazy screens stay out of the main-page chunk", () => {
  for (const site of EAGER_SITES) {
    it(`${site} has no static value import of a lazy screen`, () => {
      const source = readFileSync(resolve(SRC, site), "utf8");
      const staticImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gms)];
      const offenders = staticImports
        .map((m) => m[1]!)
        .filter((spec) => LAZY.some((name) => spec.endsWith(`/${name}`) || spec === name))
        .concat(
          staticImports.map((m) => m[1]!).filter((spec) => spec.endsWith("/MemberPickerModal")),
        );
      expect(offenders).toEqual([]);
    });
  }
});
