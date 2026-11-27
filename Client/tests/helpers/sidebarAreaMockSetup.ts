// The module mocks a real createSidebarArea needs, for a suite that builds one
// and drives it through its public result. Import it first, before anything
// that reaches the sidebar: the mocks are registered when this module runs, so
// a module imported after it sees them. The components keep the shapes
// sidebarAreaMocks.ts gives them.
import { vi } from "vitest";
import * as mocks from "./sidebarAreaMocks";

const FEATURES = "../../src/features";
const PAGE = "../../src/pages/main-page";

const FACTORIES: ReadonlyArray<readonly [string, () => object]> = [
  [`${FEATURES}/voice/livekitSession`, mocks.voiceLivekitSessionMock],
  ["@lib/logger", mocks.loggerMock],
  ["@lib/ui/toast", mocks.uiToastMock],
  ["@lib/presence/profiles", mocks.presenceProfilesMock],
  ["@tauri-apps/api/core", mocks.apiCoreMock],
  [`${FEATURES}/channels/ChannelSidebar`, mocks.channelSidebarMock],
  [`${FEATURES}/direct-messages/DmSidebar`, mocks.dmSidebarMock],
  [`${FEATURES}/members/MemberList`, mocks.memberListMock],
  [`${FEATURES}/voice/UserBar`, mocks.userBarMock],
  [`${FEATURES}/voice/VoiceWidget`, mocks.voiceWidgetMock],
  [`${FEATURES}/navigation/QuickSwitchOverlay`, mocks.quickSwitchOverlayMock],
  [`${FEATURES}/channels/CreateChannelModal`, mocks.createChannelModalMock],
  [`${FEATURES}/channels/editChannelDialog`, mocks.editChannelModalMock],
  [`${FEATURES}/channels/DeleteChannelModal`, mocks.deleteChannelModalMock],
  [`${PAGE}/VoiceCallbacks`, mocks.pageVoiceCallbacksMock],
  [`${PAGE}/OverlayManagers`, mocks.pageOverlayManagersMock],
];

for (const [path, factory] of FACTORIES) vi.doMock(path, factory);
