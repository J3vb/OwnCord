/** Page wiring for the DM feature's call handling: supplies the voice callbacks and the user id. */
import { createDmCalls } from "../../features/direct-messages/dmCalls";
import { createSidebarVoiceCallbacks } from "./VoiceCallbacks";
import { getCurrentUserId } from "./pageShared";
import type { PageState, PageApi } from "./pageState";

export function createPageDmCalls(st: PageState, pg: PageApi) {
  return createDmCalls(st, pg, { sidebarVoice: createSidebarVoiceCallbacks, getCurrentUserId });
}
