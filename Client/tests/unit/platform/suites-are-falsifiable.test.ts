// This file proves the eight `describe<Name>Suite` functions can actually
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
import type { IdentityStore } from "../../../src/platform/contracts/identityStore";
import type { PushToTalk } from "../../../src/platform/contracts/pushToTalk";
import type { AppUpdater } from "../../../src/platform/contracts/updater";
import type { SettingsStore } from "../../../src/platform/contracts/settings";
import { describeCredentialStoreSuite } from "./credentials.suite";
import type { NativeControl as CredentialsNativeControl } from "./credentials.suite";
import { describeDeepLinksSuite } from "./deepLinks.suite";
import type { NativeControl as DeepLinksNativeControl } from "./deepLinks.suite";
import { describeIdentityStoreSuite } from "./identityStore.suite";
import type { NativeControl as IdentityStoreNativeControl } from "./identityStore.suite";
import { describeLogFilesSuite } from "./logFiles.suite";
import type { LogFilesSeam, NativeControl as LogFilesNativeControl } from "./logFiles.suite";
import { describeNativeProxiesSuite } from "./nativeProxies.suite";
import type {
  NativeControl as NativeProxiesNativeControl,
  NativeProxiesSeam,
} from "./nativeProxies.suite";
import { describePushToTalkSuite } from "./pushToTalk.suite";
import type { NativeControl as PushToTalkNativeControl } from "./pushToTalk.suite";
import { describeSettingsStoreSuite } from "./settings.suite";
import type { NativeControl as SettingsNativeControl } from "./settings.suite";
import { describeAppUpdaterSuite } from "./updater.suite";
import type { NativeControl as AppUpdaterNativeControl } from "./updater.suite";

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
