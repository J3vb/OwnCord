// The desktop platform implementation: every `Platform` member, each backed by
// the native host. B7-4 and B7-5 filled it in one capability at a time,
// moving call sites out of `src/lib` as each landed.
//
// This registry is statically reachable from the entry, so anything a member
// imports statically lands in the startup chunk. A member whose native module
// was lazy before it moved keeps it a dynamic `import()` inside its methods.
import { appMetadata } from "./appMetadata";
import { appProcess } from "./appProcess";
import { autostart } from "./autostart";
import { credentials } from "./credentials";
import { deepLinks } from "./deepLinks";
import { devTools } from "./devTools";
import { externalContent } from "./externalContent";
import { fileSaver } from "./fileSave";
import { http } from "./http";
import { identity } from "./identity";
import { logFiles } from "./logFiles";
import { nativeProxies } from "./nativeProxies";
import { notifier } from "./notifications";
import { pendingMessages } from "./pendingMessages";
import { pushToTalk } from "./pushToTalk";
import { settings } from "./settings";
import { socket } from "./socket";
import { trayStatus } from "./trayStatus";
import { updater } from "./updater";
import { urlOpener } from "./urlOpener";
import { windowControl } from "./window";
import type { Platform } from "../contracts";

export const desktop: Platform = {
  appMetadata,
  appProcess,
  autostart,
  credentials,
  deepLinks,
  devTools,
  externalContent,
  fileSaver,
  http,
  identity,
  logFiles,
  nativeProxies,
  notifier,
  pendingMessages,
  pushToTalk,
  settings,
  socket,
  trayStatus,
  updater,
  urlOpener,
  window: windowControl,
};
