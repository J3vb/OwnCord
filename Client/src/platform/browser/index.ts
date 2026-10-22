// The browser platform implementation (WP 6.13b): every `Platform` member, each
// inert. A member either refuses (a rejected promise, or the typed
// "unavailable" answer its contract defines) or does nothing, exactly as its
// contract allows. 6.13c/d swap in real browser adapters for transport,
// storage and identity; until then a web build links and boots but reaches no
// host. The web vite config sends the native registry's import here
// (`vite.config.web.ts`), which is why the registry is also exported under the
// name callers import. This tree must never import a native host package or
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
import { nativeVoice } from "./nativeVoice";
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

const credentials: CredentialStore = {
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

const http: HttpClient = {
  fetch: () => refuse(),
  onUploadProgress: inertUnsubscribe,
};

const identity: IdentityStore = {
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

const nativeProxies: NativeProxies = {
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

const pendingMessages: PendingMessageStore = {
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

const settings: SettingsStore = {
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

const socket: SocketTransport = { create: createConnection };

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
  appAudio,
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

/** The name every caller imports the registry by; the web build swaps modules,
 *  not identifiers. */
export { browser as desktop };
