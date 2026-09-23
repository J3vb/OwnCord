// This file proves every `describe<Name>Suite` function can actually
// fail. Each is run once with `expectEveryTestToFail: true` against a "null
// subject" — a contract implementation whose every method is an inert no-op
// and a native handle whose every member is an inert no-op — so every test
// in the suite is wrapped in `test.fails`. A suite test that still PASSES
// against a subject that does nothing asserts nothing about behaviour, and
// `test.fails` turns that silent pass into a red run here, naming exactly
// which test needs a stronger, caller-observable assertion.
//
// The null-subject casts below are the only casts allowed anywhere in this
// milestone's test suites (see the plan's design rule 5) — every other
// legacy binding must type-check against its contract with no cast.
import type { CredentialStore } from "../../../src/platform/contracts/credentials";
import type { DeepLinks } from "../../../src/platform/contracts/deepLinks";
import type { ExternalContentBroker } from "../../../src/platform/contracts/externalContent";
import type { FileSaver } from "../../../src/platform/contracts/fileSave";
import type { HttpClient } from "../../../src/platform/contracts/http";
import type { IdentityStore } from "../../../src/platform/contracts/identityStore";
import type { PendingMessageStore } from "../../../src/platform/contracts/pendingMessages";
import type { PushToTalk } from "../../../src/platform/contracts/pushToTalk";
import type { SocketConnection } from "../../../src/platform/contracts/socket";
import type { SocketTransport } from "../../../src/platform/contracts/socket";
import type { AppUpdater } from "../../../src/platform/contracts/updater";
import type { SettingsStore } from "../../../src/platform/contracts/settings";
import { describeCredentialStoreSuite } from "./credentials.suite";
import type { NativeControl as CredentialsNativeControl } from "./credentials.suite";
import { describeDeepLinksSuite } from "./deepLinks.suite";
import type { NativeControl as DeepLinksNativeControl } from "./deepLinks.suite";
import { describeExternalContentSuite } from "./externalContent.suite";
import type { NativeControl as ExternalContentNativeControl } from "./externalContent.suite";
import { describeFileSaverSuite } from "./fileSave.suite";
import type { NativeControl as FileSaverNativeControl } from "./fileSave.suite";
import { describeHttpClientSuite } from "./http.suite";
import type { NativeControl as HttpClientNativeControl } from "./http.suite";
import { describeIdentityStoreSuite } from "./identityStore.suite";
import type { NativeControl as IdentityStoreNativeControl } from "./identityStore.suite";
import { describeLogFilesSuite } from "./logFiles.suite";
import type { LogFilesSeam, NativeControl as LogFilesNativeControl } from "./logFiles.suite";
import { describeNativeProxiesSuite } from "./nativeProxies.suite";
import type {
  NativeControl as NativeProxiesNativeControl,
  NativeProxiesSeam,
} from "./nativeProxies.suite";
import { describeLiveKitProxiesSuite } from "./livekitProxies.suite";
import type {
  LiveKitProxiesSeam,
  NativeControl as LiveKitProxiesNativeControl,
} from "./livekitProxies.suite";
import { describePendingMessagesSuite } from "./pendingMessages.suite";
import type { NativeControl as PendingMessagesNativeControl } from "./pendingMessages.suite";
import { describePushToTalkSuite } from "./pushToTalk.suite";
import type { NativeControl as PushToTalkNativeControl } from "./pushToTalk.suite";
import { describeSettingsStoreSuite } from "./settings.suite";
import type { NativeControl as SettingsNativeControl } from "./settings.suite";
import { describeSocketTransportSuite } from "./socket.suite";
import type { NativeControl as SocketTransportNativeControl } from "./socket.suite";
import { describeAppUpdaterSuite } from "./updater.suite";
import type { NativeControl as AppUpdaterNativeControl } from "./updater.suite";
import type { AppMetadata } from "../../../src/platform/contracts/appMetadata";
import type { AppProcess } from "../../../src/platform/contracts/appProcess";
import type { DevTools } from "../../../src/platform/contracts/devTools";
import type { Notifier } from "../../../src/platform/contracts/notifications";
import type { UrlOpener } from "../../../src/platform/contracts/opener";
import type { TrayStatus } from "../../../src/platform/contracts/trayStatus";
import type { Autostart } from "../../../src/platform/contracts/updater";
import type { WindowControl } from "../../../src/platform/contracts/window";
import { describeAppMetadataSuite } from "./appMetadata.suite";
import type { NativeControl as AppMetadataNativeControl } from "./appMetadata.suite";
import { describeAppProcessSuite } from "./appProcess.suite";
import type { NativeControl as AppProcessNativeControl } from "./appProcess.suite";
import { describeAutostartSuite } from "./autostart.suite";
import type { NativeControl as AutostartNativeControl } from "./autostart.suite";
import { describeDevToolsSuite } from "./devTools.suite";
import type { NativeControl as DevToolsNativeControl } from "./devTools.suite";
import { describeNotifierSuite } from "./notifier.suite";
import type { NativeControl as NotifierNativeControl } from "./notifier.suite";
import { describeUrlOpenerSuite } from "./opener.suite";
import type { NativeControl as UrlOpenerNativeControl } from "./opener.suite";
import { describeNativeVoiceSuite } from "./nativeVoice.suite";
import type { NativeControl as NativeVoiceNativeControl } from "./nativeVoice.suite";
import type { NativeVoice } from "../../../src/platform/contracts/nativeVoice";
import { describeTrayStatusSuite } from "./trayStatus.suite";
import type { NativeControl as TrayStatusNativeControl } from "./trayStatus.suite";
import { describeWindowControlSuite } from "./window.suite";
import type { NativeControl as WindowControlNativeControl } from "./window.suite";

const failEveryTest = { expectEveryTestToFail: true };

describeCredentialStoreSuite(async () => {
  const subject = {
    save: async () => undefined,
    load: async () => undefined,
    delete: async () => undefined,
    loginWithSavedPassword: async () => undefined,
  } as unknown as CredentialStore;
  const native: CredentialsNativeControl = {
    succeedWith: () => undefined,
    failWith: () => undefined,
    unavailable: () => undefined,
  };
  return { subject, native };
}, failEveryTest);

describeIdentityStoreSuite(async () => {
  const subject = {
    saveKey: async () => undefined,
    loadKey: async () => undefined,
    deleteKey: async () => undefined,
    storePin: async () => undefined,
    getPin: async () => undefined,
  } as unknown as IdentityStore;
  const native: IdentityStoreNativeControl = {
    succeedWith: () => undefined,
    failWith: () => undefined,
    unavailable: () => undefined,
  };
  return { subject, native };
}, failEveryTest);

describeSettingsStoreSuite(async () => {
  const subject = {
    load: async () => undefined,
    save: async () => undefined,
  } as unknown as SettingsStore;
  const native: SettingsNativeControl = {
    succeedWith: () => undefined,
    failWith: () => undefined,
    unavailable: () => undefined,
  };
  return { subject, native };
}, failEveryTest);

describeLogFilesSuite(async () => {
  const subject = {
    init: async () => undefined,
    flush: async () => undefined,
    clearPending: async () => undefined,
    getDir: () => undefined,
  } as unknown as LogFilesSeam;
  const native: LogFilesNativeControl = {
    succeedWith: () => undefined,
    unavailable: () => undefined,
    logEntry: () => undefined,
    written: () => [],
  };
  return { subject, native };
}, failEveryTest);

describeNativeProxiesSuite(async () => {
  const subject = {
    ensureHttpProxy: async () => undefined,
  } as unknown as NativeProxiesSeam;
  const native: NativeProxiesNativeControl = {
    succeedWith: () => undefined,
    failWith: () => undefined,
  };
  return { subject, native };
}, failEveryTest);

describeAppUpdaterSuite(async () => {
  const subject = {
    checkForUpdate: async () => undefined,
    downloadAndInstallUpdate: async () => undefined,
    subscribeToInstall: () => () => undefined,
  } as unknown as AppUpdater;
  const native: AppUpdaterNativeControl = {
    checkSucceedsWith: () => undefined,
    checkFailsWith: () => undefined,
    installSucceeds: () => undefined,
    installFailsWith: () => undefined,
  };
  return { subject, native };
}, failEveryTest);

describePushToTalkSuite(async () => {
  const subject = {
    init: async () => undefined,
    stop: async () => undefined,
    updateKey: async () => undefined,
    captureKeyPress: async () => undefined,
  } as unknown as PushToTalk;
  const native: PushToTalkNativeControl = {
    captureSucceedsWith: () => undefined,
    captureFailsWith: () => undefined,
    configuredKey: () => undefined,
    pollingStarted: () => false,
  };
  return { subject, native };
}, failEveryTest);

describeDeepLinksSuite(async () => {
  const subject = {
    init: async () => undefined,
  } as unknown as DeepLinks;
  const native: DeepLinksNativeControl = {
    coldStartLinks: () => undefined,
  };
  return { subject, native };
}, failEveryTest);

describeHttpClientSuite(async () => {
  const subject = {
    fetch: async () => undefined,
  } as unknown as HttpClient;
  const native: HttpClientNativeControl = {
    respondsWith: () => undefined,
    failsWith: () => undefined,
    requested: () => [],
  };
  return { subject, native };
}, failEveryTest);

describeSocketTransportSuite(async () => {
  const subject = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    send: async () => undefined,
    acceptCertificate: async () => undefined,
    onStateChange: () => () => undefined,
    onMessage: () => () => undefined,
    onCertFirstUse: () => () => undefined,
    onCertMismatch: () => () => undefined,
    startCertListener: async () => undefined,
  } as unknown as SocketConnection;
  // A capability that hands the same inert transport to every caller: `create`
  // must return an independent one, and this must fail that.
  const transport = { create: () => subject } as unknown as SocketTransport;
  const native: SocketTransportNativeControl = {
    opens: async () => undefined,
    closes: async () => undefined,
    delivers: async () => undefined,
    emitsCert: async () => undefined,
    connectFailsWith: () => undefined,
    sendFailsWith: () => undefined,
    unavailable: () => undefined,
    sent: () => [],
    accepted: () => [],
  };
  return { transport, subject, native };
}, failEveryTest);

describePendingMessagesSuite(async () => {
  const subject = {
    load: async () => undefined,
    save: async () => undefined,
    delete: async () => undefined,
  } as unknown as PendingMessageStore;
  const native: PendingMessagesNativeControl = {
    loadReturns: () => undefined,
    failWith: () => undefined,
    unavailable: () => undefined,
    saved: () => [],
    deleted: () => [],
  };
  return { subject, native };
}, failEveryTest);

describeFileSaverSuite(async () => {
  const subject = {
    pickSaveLocation: async () => undefined,
    writeFile: async () => undefined,
  } as unknown as FileSaver;
  const native: FileSaverNativeControl = {
    dialogResolves: () => undefined,
    dialogFailsWith: () => undefined,
    written: () => [],
    writeFailsWith: () => undefined,
  };
  return { subject, native };
}, failEveryTest);

describeLiveKitProxiesSuite(async () => {
  const subject = {
    setLiveKitServerHost: () => undefined,
    resolveLiveKitUrl: async () => undefined,
    stopLiveKitProxy: () => undefined,
  } as unknown as LiveKitProxiesSeam;
  const native: LiveKitProxiesNativeControl = {
    succeedWith: () => undefined,
    failWith: () => undefined,
  };
  return { subject, native };
}, failEveryTest);

describeNotifierSuite(async () => {
  const subject = {
    permissionGranted: async () => undefined,
    requestPermission: async () => undefined,
    show: async () => undefined,
    flashTaskbar: async () => undefined,
  } as unknown as Notifier;
  const native: NotifierNativeControl = {
    permissionIs: () => undefined,
    userAnswers: () => undefined,
    unavailable: () => undefined,
    shown: () => [],
    attentionRequests: () => 0,
  };
  return { subject, native };
}, failEveryTest);

describeWindowControlSuite(async () => {
  const subject = {
    isMaximized: async () => undefined,
    availableMonitors: async () => undefined,
    outerPosition: async () => undefined,
    outerSize: async () => undefined,
    center: async () => undefined,
  } as unknown as WindowControl;
  const native: WindowControlNativeControl = {
    maximized: () => undefined,
    monitors: () => undefined,
    monitorsFailWith: () => undefined,
    placedAt: () => undefined,
    centered: () => 0,
  };
  return { subject, native };
}, failEveryTest);

describeUrlOpenerSuite(async () => {
  const subject = { open: async () => undefined } as unknown as UrlOpener;
  const native: UrlOpenerNativeControl = {
    failWith: () => undefined,
    opened: () => [],
  };
  return { subject, native };
}, failEveryTest);

describeAppMetadataSuite(async () => {
  const subject = { getVersion: async () => undefined } as unknown as AppMetadata;
  const native: AppMetadataNativeControl = {
    version: () => undefined,
    failWith: () => undefined,
  };
  return { subject, native };
}, failEveryTest);

describeDevToolsSuite(async () => {
  const subject = { open: async () => undefined } as unknown as DevTools;
  const native: DevToolsNativeControl = {
    failWith: () => undefined,
    opened: () => 0,
  };
  return { subject, native };
}, failEveryTest);

describeAutostartSuite(async () => {
  const subject = {
    isEnabled: async () => undefined,
    enable: async () => undefined,
    disable: async () => undefined,
  } as unknown as Autostart;
  const native: AutostartNativeControl = {
    enabledIs: () => undefined,
    failWith: () => undefined,
    state: () => false,
  };
  return { subject, native };
}, failEveryTest);

describeAppProcessSuite(async () => {
  const subject = { relaunch: async () => undefined } as unknown as AppProcess;
  const native: AppProcessNativeControl = {
    failWith: () => undefined,
    relaunches: () => 0,
  };
  return { subject, native };
}, failEveryTest);

describeTrayStatusSuite(async () => {
  const subject = { onStatusChange: () => () => undefined } as unknown as TrayStatus;
  const native: TrayStatusNativeControl = {
    emits: async () => undefined,
  };
  return { subject, native };
}, failEveryTest);

describeNativeVoiceSuite(async () => {
  const subject = {
    setRoomKey: async () => undefined,
    clearRoomKey: async () => undefined,
    connect: async () => undefined,
    disconnect: async () => undefined,
    setMicrophone: async () => undefined,
    setSubscribed: async () => undefined,
    debugInfo: async () => undefined,
    listDevices: async () => undefined,
    setDevice: async () => undefined,
    onEvent: () => () => undefined,
  } as unknown as NativeVoice;
  const native: NativeVoiceNativeControl = {
    connectsAs: () => undefined,
    publishesCameraAs: () => undefined,
    hasDevices: () => undefined,
    commands: () => [],
    emits: async () => undefined,
  };
  return { subject, native };
}, failEveryTest);

describeExternalContentSuite(async () => {
  const subject = {
    preview: async () => undefined,
    image: async () => undefined,
  } as unknown as ExternalContentBroker;
  const native: ExternalContentNativeControl = {
    answers: () => undefined,
    refuses: () => undefined,
    unavailable: () => undefined,
    asked: () => [],
  };
  return { subject, native };
}, failEveryTest);
