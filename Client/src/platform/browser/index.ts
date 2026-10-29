// The browser platform implementation (WP 6.13b): every `Platform` member.
// Transport, storage and identity are real browser adapters (6.13c), one file
// each, used only in a secure context: on a page that is not one, they stay
// inert, so the app reaches no host and stores nothing rather than half-work.
// The rest is 6.13d: notifications (Web Notification API, also secure-context
// only), file save (a download), logs (a memory ring), invite deep links
// (`?invite=`), external content (refused) and the URL opener (a new tab) are
// browser adapters, one file each; every other member either refuses (a rejected promise, or the typed
// "unavailable" answer its contract defines) or does nothing, exactly as its
// contract allows, and the four contracts a Settings control sits on say so
// through `available: false`. Push-to-talk stays unsupported: an in-tab key
// cannot gate the mic while the tab is in the background, which is the point of
// the feature. The web vite config sends the
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
  DevTools,
  GameDetector,
  MediaDetector,
  GlobalShortcuts,
  HttpClient,
  IdentityStore,
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
  WindowControl,
  WindowPrefs,
} from "../contracts";
import type { SocketConnection } from "../contracts/socket";
import { credentials as browserCredentials } from "./credentials";
import { deepLinks } from "./deepLinks";
import { externalContent } from "./externalContent";
import { fileSaver } from "./fileSave";
import { http as browserHttp } from "./http";
import { identity as browserIdentity } from "./identity";
import { logFiles } from "./logFiles";
import { nativeProxies as browserNativeProxies } from "./nativeProxies";
import { nativeVoice } from "./nativeVoice";
import { notifier as browserNotifier } from "./notifications";
import { pendingMessages as browserPendingMessages } from "./pendingMessages";
import { settings as browserSettings } from "./settings";
import { socket as browserSocket } from "./socket";
import { inertUnsubscribe, refuse, UnsupportedKeysError } from "./unavailable";
import { urlOpener } from "./urlOpener";

const appAudio: AppAudio = {
  available: async () => false,
  start: async () => ({ ok: false, code: "unavailable" }),
  stop: async () => undefined,
};

const appMetadata: AppMetadata = {
  getVersion: () => refuse(),
};

const appProcess: AppProcess = {
  // A page relaunches by reloading itself.
  relaunch: async () => {
    window.location.reload();
  },
  reportReady: async () => undefined,
};

const autostart: Autostart = {
  available: false,
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

const devTools: DevTools = {
  available: false,
  open: async () => undefined,
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
    triggersUnnamed: false,
    sessionRefused: false,
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

const inertNativeProxies: NativeProxies = {
  ensureHttpProxy: () => refuse(),
  setLiveKitServerHost: () => undefined,
  resolveLiveKitUrl: (_proxyPath, directUrl) =>
    directUrl === undefined ? refuse() : Promise.resolve(directUrl),
  stopLiveKitProxy: () => undefined,
};

const inertNotifier: Notifier = {
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

// The web build is only ever served by one server's portal (6.13a), so the page
// is bound to its own host. `location.host` is already canonical (lower case,
// no default port), the form every credential and profile key takes.
const serverScope: ServerScope = { fixedHost: globalThis.location.host };

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
  readonly notifier: Notifier;
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
      notifier: browserNotifier,
      nativeProxies: browserNativeProxies,
      pendingMessages: browserPendingMessages,
      settings: browserSettings,
      socket: browserSocket,
    }
  : {
      credentials: inertCredentials,
      http: inertHttp,
      identity: inertIdentity,
      notifier: inertNotifier,
      nativeProxies: inertNativeProxies,
      pendingMessages: inertPendingMessages,
      settings: inertSettings,
      socket: inertSocket,
    };

const gameDetector: GameDetector = {
  available: false,
  detect: async () => null,
  listRunningPrograms: async () => [],
};

const mediaDetector: MediaDetector = {
  available: false,
  detect: async () => ({ state: "none" }),
};

const systemIdle: SystemIdle = {
  idleMs: async () => null,
};

const trayStatus: TrayStatus = {
  onStatusChange: inertUnsubscribe,
};

const updater: AppUpdater = {
  available: false,
  checkForUpdate: async () => ({
    available: false,
    version: null,
    body: null,
    manual_upgrade: false,
  }),
  downloadAndInstallUpdate: () => refuse(),
  subscribeToInstall: inertUnsubscribe,
};

const windowControl: WindowControl = {
  available: false,
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
  gameDetector,
  mediaDetector,
  logFiles,
  nativeVoice,
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
