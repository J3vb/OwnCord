// Re-exports every platform contract interface plus the `Platform` shape that
// groups them — one readonly member per interface above. A contract's
// auxiliary types (options, results, events) are imported from its own file.
// Type-only: `isolatedModules` requires `export type` for every re-export
// here, or the build fails.

export type { HttpClient } from "./http";
export type { SocketTransport } from "./socket";
export type { CredentialStore } from "./credentials";
export type { IdentityStore } from "./identityStore";
export type { PendingMessageStore } from "./pendingMessages";
export type { SettingsStore } from "./settings";
export type { LogFiles } from "./logFiles";
export type { FileSaver } from "./fileSave";
export type { NativeProxies } from "./nativeProxies";
export type { Notifier } from "./notifications";
export type { WindowControl } from "./window";
export type { AppUpdater, Autostart } from "./updater";
export type { UrlOpener } from "./opener";
export type { PushToTalk } from "./pushToTalk";
export type { DeepLinks } from "./deepLinks";
export type { AppMetadata } from "./appMetadata";
export type { DevTools } from "./devTools";
export type { AppProcess } from "./appProcess";
export type { TrayStatus } from "./trayStatus";
export type {
  ExternalContentBroker,
  ExternalContentFailure,
  ExternalContentResult,
  ExternalImageHandle,
  ExternalImageSource,
  ExternalPreview,
} from "./externalContent";

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
import type { ExternalContentBroker } from "./externalContent";

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
  readonly externalContent: ExternalContentBroker;
}
