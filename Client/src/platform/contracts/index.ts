// Re-exports every platform contract plus the `Platform` shape that groups
// them — one readonly member per interface above. Type-only: `isolatedModules`
// requires `export type` for every re-export here, or the build fails.
//
// Grows one row-group at a time: rows 1-8 (the B7-4 group) land here first,
// rows 9-17 (the B7-5 group) are added in the next commit.

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

import type { HttpClient } from "./http";
import type { SocketTransport } from "./socket";
import type { CredentialStore } from "./credentials";
import type { IdentityStore } from "./identityStore";
import type { PendingMessageStore } from "./pendingMessages";
import type { SettingsStore } from "./settings";
import type { LogFiles } from "./logFiles";
import type { FileSaver } from "./fileSave";

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
}
