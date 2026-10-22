// The browser platform implementation (WP 6.13b): every `Platform` member.
// Transport, storage and identity are real browser adapters (6.13c), one file
// each, used only in a secure context: on a page that is not one, they stay
// inert, so the app reaches no host and stores nothing rather than half-work.
// Every other member is still inert (6.13d): it either refuses (a rejected
// promise, or the typed "unavailable" answer its contract defines) or does
// nothing, exactly as its contract allows. The web vite config sends the
// native registry's import here (`vite.config.web.ts`), which is why the
// registry is also exported under the name callers import. This tree must never import a native host package or
// anything from the native implementation tree (eslint and the registry test
// enforce it).
import type {
  AppAudio,
  AppMetadata,
  AppProcess,
  AppUpdater,
  Autostart,
  CredentialStore,
  DeepLinks,
  DevTools,
  ExternalContentBroker,
  FileSaver,
  GlobalShortcuts,
  HttpClient,
  IdentityStore,
  LogFiles,
  NativeProxies,
  Notifier,
  PendingMessageStore,
  Platform,
  PushToTalk,
  ServerScope,
  SettingsStore,
  SocketTransport,
  SystemIdle,
  TrayStatus,
  UrlOpener,
  WindowControl,
  WindowPrefs,
} from "../contracts";
import type { SocketConnection } from "../contracts/socket";
import { credentials as browserCredentials } from "./credentials";
import { http as browserHttp } from "./http";
import { identity as browserIdentity } from "./identity";
import { nativeProxies as browserNativeProxies } from "./nativeProxies";
import { nativeVoice } from "./nativeVoice";
import { pendingMessages as browserPendingMessages } from "./pendingMessages";
import { settings as browserSettings } from "./settings";
import { socket as browserSocket } from "./socket";
import { inertUnsubscribe, refuse, UnsupportedKeysError } from "./unavailable";

const appAudio: AppAudio = {
  available: async () => false,
  start: async () => ({ ok: false, code: "unavailable" }),
  stop: async () => undefined,
};

const appMetadata: AppMetadata = {
  getVersion: () => refuse(),
};

const appProcess: AppProcess = {
  relaunch: async () => undefined,
  reportReady: async () => undefined,
};

const autostart: Autostart = {
  isEnabled: async () => false,
  enable: () => refuse(),
  disable: async () => undefined,
};

const inertCredentials: CredentialStore = {
  save: async () => false,
  load: async () => null,
  delete: async () => false,
  loginWithSavedPassword: async () => null,
};

const deepLinks: DeepLinks = {
  init: async () => undefined,
};

const devTools: DevTools = {
  open: async () => undefined,
};

const externalContent: ExternalContentBroker = {
  preview: async () => ({ ok: false, failure: "unavailable" }),
  image: async () => ({ ok: false, failure: "unavailable" }),
};

const fileSaver: FileSaver = {
  pickSaveLocation: async () => null,
  writeFile: () => refuse(),
};

const globalShortcuts: GlobalShortcuts = {
  start: async () => undefined,
  supported: async () => false,
  setKeys: async () => undefined,
  status: async () => ({
    backend: "none",
    portalVersion: 0,
    triggers: { ptt: null, mute: null, deafen: null },
    canConfigure: false,
  }),
  bindPortal: () => Promise.reject(new UnsupportedKeysError()),
  configurePortal: () => Promise.reject(new UnsupportedKeysError()),
  onStatusChange: inertUnsubscribe,
  onShortcut: inertUnsubscribe,
};

const inertHttp: HttpClient = {
  fetch: () => refuse(),
  onUploadProgress: inertUnsubscribe,
};

const inertIdentity: IdentityStore = {
  saveKey: async () => false,
  loadKey: async () => null,
  deleteKey: async () => false,
  storePin: async () => "no-store",
  getPin: async () => ({ status: "unavailable" }),
};

const logFiles: LogFiles = {
  init: async () => () => undefined,
  flush: async () => undefined,
  clearPending: async () => undefined,
  getDir: () => null,
  clearAll: async () => undefined,
  readAll: async () => [],
  readNative: async () => [],
  openFolder: async () => ({ ok: false, error: "log files are unavailable in the browser" }), // i18n-exempt: diagnostic
};

const inertNativeProxies: NativeProxies = {
  ensureHttpProxy: () => refuse(),
  setLiveKitServerHost: () => undefined,
  resolveLiveKitUrl: (_proxyPath, directUrl) =>
    directUrl === undefined ? refuse() : Promise.resolve(directUrl),
  stopLiveKitProxy: () => undefined,
};

const notifier: Notifier = {
  readsOsPermission: false,
  permissionGranted: async () => false,
  requestPermission: async () => false,
  show: async () => undefined,
  showMessage: async () => undefined,
  showCall: async () => undefined,
  clearCall: async () => undefined,
  onMessageActivated: inertUnsubscribe,
  flashTaskbar: async () => undefined,
  requestAttention: async () => undefined,
  setUnreadBadge: async () => undefined,
};

const inertPendingMessages: PendingMessageStore = {
  load: async () => null,
  save: async () => undefined,
  delete: async () => undefined,
};

const pushToTalk: PushToTalk = {
  init: async () => undefined,
  stop: async () => undefined,
  updateKey: async () => undefined,
  captureKeyPress: () => refuse(),
  supported: async () => false,
};

// 6.13e sets `fixedHost` from the portal; until then the browser is unscoped.
const serverScope: ServerScope = { fixedHost: null };

const inertSettings: SettingsStore = {
  load: async () => null,
  save: async () => undefined,
};

function createConnection(): SocketConnection {
  return {
    connect: () => refuse(),
    disconnect: async () => undefined,
    send: () => refuse(),
    acceptCertificate: async () => undefined,
    onStateChange: inertUnsubscribe,
    onMessage: inertUnsubscribe,
    onCertFirstUse: inertUnsubscribe,
    onCertMismatch: inertUnsubscribe,
    startCertListener: async () => undefined,
  };
}

const inertSocket: SocketTransport = { create: createConnection };

/** The members that run only in a secure context. */
interface SecureMembers {
  readonly credentials: CredentialStore;
  readonly http: HttpClient;
  readonly identity: IdentityStore;
  readonly nativeProxies: NativeProxies;
  readonly pendingMessages: PendingMessageStore;
  readonly settings: SettingsStore;
  readonly socket: SocketTransport;
}

/** True only on a page the browser counts as a secure context (https, or a
 *  loopback host). Read once: a page cannot change it. */
function isSecurePage(): boolean {
  return globalThis.isSecureContext === true;
}

const secureMembers: SecureMembers = isSecurePage()
  ? {
      credentials: browserCredentials,
      http: browserHttp,
      identity: browserIdentity,
      nativeProxies: browserNativeProxies,
      pendingMessages: browserPendingMessages,
      settings: browserSettings,
      socket: browserSocket,
    }
  : {
      credentials: inertCredentials,
      http: inertHttp,
      identity: inertIdentity,
      nativeProxies: inertNativeProxies,
      pendingMessages: inertPendingMessages,
      settings: inertSettings,
      socket: inertSocket,
    };

const systemIdle: SystemIdle = {
  idleMs: async () => null,
};

const trayStatus: TrayStatus = {
  onStatusChange: inertUnsubscribe,
};

const updater: AppUpdater = {
  checkForUpdate: async () => ({
    available: false,
    version: null,
    body: null,
    manual_upgrade: false,
  }),
  downloadAndInstallUpdate: () => refuse(),
  subscribeToInstall: inertUnsubscribe,
};

const urlOpener: UrlOpener = {
  open: () => refuse(),
};

const windowControl: WindowControl = {
  isMaximized: async () => false,
  availableMonitors: async () => [],
  outerPosition: async () => ({ x: 0, y: 0 }),
  outerSize: async () => ({ width: 0, height: 0 }),
  center: async () => undefined,
  setFullscreen: async () => undefined,
  setZoom: async () => false,
};

const windowPrefs: WindowPrefs = {
  load: async () => null,
  set: async () => false,
};

export const browser: Platform = {
  ...secureMembers,
  appAudio,
  appMetadata,
  appProcess,
  autostart,
  deepLinks,
  devTools,
  externalContent,
  fileSaver,
  logFiles,
  nativeVoice,
  notifier,
  pushToTalk,
  globalShortcuts,
  serverScope,
  systemIdle,
  trayStatus,
  updater,
  urlOpener,
  window: windowControl,
  windowPrefs,
};

/** The name every caller imports the registry by; the web build swaps modules,
 *  not identifiers. */
export { browser as desktop };
