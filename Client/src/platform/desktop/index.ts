// The desktop platform implementation: every `Platform` member, each backed by
// the native host. It was filled in one capability at a time,
// moving call sites out of `src/lib` as each landed.
//
// This registry is statically reachable from the entry, so anything a member
// imports statically lands in the startup chunk. A member whose native module
// was lazy before it moved keeps it a dynamic `import()` inside its methods.
import { appAudio } from "./appAudio";
import { appMetadata } from "./appMetadata";
import { appProcess } from "./appProcess";
import { autostart } from "./autostart";
import { callService } from "./callService";
import { credentials } from "./credentials";
import { deepLinks } from "./deepLinks";
import { devTools } from "./devTools";
import { externalContent } from "./externalContent";
import { fileSaver } from "./fileSave";
import { http } from "./http";
import { identity } from "./identity";
import { logFiles } from "./logFiles";
import { nativeFiles } from "./nativeFiles";
import { nativeProxies } from "./nativeProxies";
import { nativeVoice } from "./nativeVoice";
import { notifier } from "./notifications";
import { pendingMessages } from "./pendingMessages";
import { pushToTalk } from "./pushToTalk";
import { globalShortcuts } from "./globalShortcuts";
import { serverScope } from "./serverScope";
import { settings } from "./settings";
import { socket } from "./socket";
import { systemIdle } from "./systemIdle";
import { gameDetector } from "./gameDetector";
import { mediaDetector } from "./mediaDetector";
import { trayStatus } from "./trayStatus";
import { updater } from "./updater";
import { urlOpener } from "./urlOpener";
import { windowControl } from "./window";
import { windowPrefs } from "./windowPrefs";
import type { Platform } from "../contracts";

export const desktop: Platform = {
  appAudio,
  appMetadata,
  appProcess,
  autostart,
  callService,
  credentials,
  deepLinks,
  devTools,
  externalContent,
  fileSaver,
  gameDetector,
  mediaDetector,
  http,
  identity,
  logFiles,
  nativeFiles,
  nativeProxies,
  nativeVoice,
  notifier,
  pendingMessages,
  pushToTalk,
  globalShortcuts,
  serverScope,
  settings,
  socket,
  systemIdle,
  trayStatus,
  updater,
  urlOpener,
  window: windowControl,
  windowPrefs,
};
