// Re-exports every platform contract plus the `Platform` shape that groups
// them — one readonly member per interface above. Type-only: `isolatedModules`
// requires `export type` for every re-export here, or the build fails.

export type { HttpClient } from "./http";
export type {
  SocketTransport,
  SocketConnectOptions,
  SocketConnectionState,
  SocketCertEvent,
} from "./socket";
export type { CredentialStore, SavedCredential, SavedLoginResponse } from "./credentials";
export type { IdentityStore, StoreIdentityPinResult, IdentityPinLookup } from "./identityStore";
export type { PendingMessageStore, PendingMessageOwner } from "./pendingMessages";
export type { SettingsStore, SettingsSnapshot, SettingsProfile } from "./settings";
export type { LogFiles } from "./logFiles";
export type { FileSaver } from "./fileSave";
export type { NativeProxies } from "./nativeProxies";
export type { Notifier, NotifierShowOptions } from "./notifications";
export type { WindowControl, WindowRect, MonitorRect } from "./window";
export type {
  AppUpdater,
  Autostart,
  UpdateCheckResult,
  DownloadProgress,
  UpdateInstallState,
} from "./updater";
export type { UrlOpener } from "./opener";
export type { PushToTalk } from "./pushToTalk";
export type { DeepLinks } from "./deepLinks";
export type { AppMetadata } from "./appMetadata";
export type { DevTools } from "./devTools";
export type { AppProcess } from "./appProcess";
export type { TrayStatus } from "./trayStatus";

import type { HttpClient } from "./http";
import type { SocketTransport } from "./socket";
import type { CredentialStore } from "./credentials";
import type { IdentityStore } from "./identityStore";
import type { PendingMessageStore } from "./pendingMessages";
import type { SettingsStore } from "./settings";
import type { LogFiles } from "./logFiles";
import type { FileSaver } from "./fileSave";
import type { NativeProxies } from "./nativeProxies";
import type { Notifier } from "./notifications";
import type { WindowControl } from "./window";
import type { AppUpdater, Autostart } from "./updater";
import type { UrlOpener } from "./opener";
import type { PushToTalk } from "./pushToTalk";
import type { DeepLinks } from "./deepLinks";
import type { AppMetadata } from "./appMetadata";
import type { DevTools } from "./devTools";
import type { AppProcess } from "./appProcess";
import type { TrayStatus } from "./trayStatus";

/** Every platform capability, one readonly member per contract interface. */
export interface Platform {
  readonly http: HttpClient;
  readonly socket: SocketTransport;
  readonly credentials: CredentialStore;
  readonly identity: IdentityStore;
  readonly pendingMessages: PendingMessageStore;
  readonly settings: SettingsStore;
  readonly logFiles: LogFiles;
  readonly fileSaver: FileSaver;
  readonly nativeProxies: NativeProxies;
  readonly notifier: Notifier;
  readonly window: WindowControl;
  readonly updater: AppUpdater;
  readonly autostart: Autostart;
  readonly urlOpener: UrlOpener;
  readonly pushToTalk: PushToTalk;
  readonly deepLinks: DeepLinks;
  readonly appMetadata: AppMetadata;
  readonly devTools: DevTools;
  readonly appProcess: AppProcess;
  readonly trayStatus: TrayStatus;
}
