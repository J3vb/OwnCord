// ARCH-06 canaries: every custom lint rule in eslint-rules.js must stay
// enabled by the real eslint.config.js at the production module it guards, and
// must still fire on its shape. A canary fails if the rule's scope stops
// covering that module, or if the rule stops firing on its shape. #1587 showed how
// a rule can go inert: its scope is a `files:` glob in eslint.config.js, and a
// refactor that moves the guarded code to a new file (or changes the shape the
// matcher keys on) leaves the rule matching nothing while its RuleTester cases
// still pass. So each canary asserts that the real eslint.config.js ENABLES the
// rule at the filePath of a real production module it is meant to cover, and
// separately that the rule reports on the canary's code shape when run in
// isolation (the filePath is passed only so a path-scoped rule sees its module).
//
// Adding a rule to eslint-rules.js without a canary here fails the
// "every rule has a canary" check at the bottom of this file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ESLint, Linter } from "eslint";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- no type declarations for the plain-JS rules module
import localRules from "../../eslint-rules.js";

const clientRoot = path.resolve(__dirname, "../..");

// Scope is checked through the real eslint.config.js: a rule the config no
// longer applies to the owning module is the inert-guard failure. Firing is
// checked through a flat Linter with the real rule object, which keeps this
// fast — the config's type-aware parser is not needed to prove a syntax
// matcher still matches.
const eslint = new ESLint({ cwd: clientRoot });
const linter = new Linter({ configType: "flat" });
const flatConfig = {
  // The canary filenames are .ts paths, which a flat config only lints when it names them.
  files: ["**/*.ts"],
  languageOptions: { ecmaVersion: 2022 as const, sourceType: "module" as const },
  plugins: { local: localRules },
};

interface Canary {
  /** The rule id as configured in eslint.config.js. */
  readonly rule: string;
  /** A real in-scope production module the rule is meant to cover. */
  readonly filePath: string;
  /** A shape that MUST trip the rule at that path. */
  readonly code: string;
  /** The messageId the rule reports. */
  readonly messageId: string;
  /** Names the shape when a rule has more than one canary. */
  readonly shape?: string;
  /** The severity eslint.config.js sets: 2 (error, the default) or 1 (warn). */
  readonly severity?: 1 | 2;
  /** True when eslint.config.js passes the rule an options object (a baseline). */
  readonly hasOptions?: boolean;
}

const CANARIES: readonly Canary[] = [
  {
    rule: "local/no-leave-voice-when-superseded",
    filePath: "src/lib/voice/livekitReconnect.ts",
    code: `async function attemptAutoReconnect(deps, signal, channelId, owner) {
      const superseded = () => reconnectSuperseded(signal, channelId, owner, deps.getState());
      if (superseded()) {
        deps.leaveVoice();
        return;
      }
    }`,
    messageId: "unsafeLeaveVoice",
  },
  {
    rule: "local/e2ee-epoch-needs-keypair-check",
    filePath: "src/features/voice/e2eeEpoch.ts",
    code: `function handleOfferInner(epochBefore) {
      if (this._e2eeEpoch !== epochBefore) return;
    }`,
    messageId: "missingKeypairCheck",
  },
  {
    rule: "local/e2ee-verified-status-literal",
    filePath: "src/features/voice/e2eePeerState.ts",
    code: `function f(userId, computedStatus) {
      this.setPeerVerification({ userId, status: computedStatus, safetyNumber: null });
    }`,
    messageId: "dynamicStatus",
  },
  {
    rule: "local/no-identity-scope-fallback",
    filePath: "src/features/voice/e2eeIdentity.ts",
    code: `async function ensure(host, userId) {
      return await getOrCreateIdentityKeyPair(host, userId ?? 0);
    }`,
    messageId: "placeholderFallback",
  },
  {
    rule: "local/invoke-needs-try-catch",
    severity: 2,
    filePath: "src/platform/desktop/nativeVoiceService.ts",
    code: `const service = { clearRoomKey: () => invoke("native_voice_clear_key") };`,
    messageId: "bareInvoke",
  },
  {
    rule: "local/no-store-write-in-ws-on",
    filePath: "src/pages/main-page/ChannelController.ts",
    code: `import { setActiveChannel } from "@stores/channels.store";
    ws.on("x", () => { setActiveChannel(1); });`,
    messageId: "storeWriteOutsideDispatcher",
  },
  // One canary per widened shape (the receivers, methods and write forms the
  // first version could not see), each at a real production module.
  {
    rule: "local/no-store-write-in-ws-on",
    shape: "this.ws receiver",
    filePath: "src/pages/main-page/ChannelController.ts",
    code: `import { setActiveChannel } from "@stores/channels.store";
    this.ws.on("x", () => { setActiveChannel(1); });`,
    messageId: "storeWriteOutsideDispatcher",
  },
  {
    rule: "local/no-store-write-in-ws-on",
    shape: "onStateChange method",
    filePath: "src/pages/main-page/ChannelController.ts",
    code: `import { setActiveChannel } from "@stores/channels.store";
    ws.onStateChange(() => { setActiveChannel(1); });`,
    messageId: "storeWriteOutsideDispatcher",
  },
  {
    rule: "local/no-store-write-in-ws-on",
    shape: "setState on a store",
    filePath: "src/main.ts",
    code: `import { authStore } from "@stores/auth.store";
    ws.on("x", () => { authStore.setState({}); });`,
    messageId: "storeWriteOutsideDispatcher",
  },
  {
    rule: "local/no-store-write-in-ws-on",
    shape: "getState() mutator",
    filePath: "src/lib/presence/presence.ts",
    code: `import { messagesStore } from "@stores/messages.store";
    ws.on("x", (p) => { messagesStore.getState().addMessage(p); });`,
    messageId: "storeWriteOutsideDispatcher",
  },
  {
    rule: "local/no-store-write-in-ws-on",
    shape: "named callback",
    filePath: "src/pages/main-page/SidebarArea.ts",
    code: `import { setActiveChannel } from "@stores/channels.store";
    function onX() { setActiveChannel(1); }
    ws.on("x", onX);`,
    messageId: "storeWriteOutsideDispatcher",
  },
  {
    rule: "local/no-raw-html-sink",
    filePath: "src/lib/dom.ts",
    code: `function f(el, text) { el.innerHTML = text; }`,
    messageId: "htmlSink",
  },
  {
    rule: "local/no-raw-html-sink",
    shape: "insertAdjacentHTML",
    filePath: "src/components/EmojiPicker.ts",
    code: `function f(el, html) { el.insertAdjacentHTML("beforeend", html); }`,
    messageId: "htmlSink",
  },
  {
    rule: "local/subscription-result-kept",
    filePath: "src/main.ts",
    code: `import { onAuthCleared } from "@stores/auth.store";
    onAuthCleared(reset);`,
    messageId: "discarded",
  },
  {
    rule: "local/subscription-result-kept",
    shape: "registerSessionReset",
    filePath: "src/stores/messages.store.ts",
    code: `import { registerSessionReset } from "@lib/net/sessionRegistry";
    registerSessionReset("x:y", reset);`,
    messageId: "discarded",
  },
  {
    rule: "local/subscription-result-kept",
    shape: "store.subscribe",
    filePath: "src/stores/voice.store.ts",
    code: `voiceStore.subscribe(() => {});`,
    messageId: "discarded",
  },
  {
    rule: "local/subscription-result-kept",
    shape: "ws.on",
    filePath: "src/lib/dispatcher.ts",
    code: `this.ws.on("x", () => {});`,
    messageId: "discarded",
  },
  {
    rule: "local/layer-direction",
    filePath: "src/lib/presence/presence.ts",
    code: `import { MainPage } from "@pages/MainPage";`,
    messageId: "upwardImport",
    hasOptions: true,
  },
  {
    rule: "local/layer-direction",
    shape: "relative",
    filePath: "src/stores/voice.store.ts",
    code: `import { x } from "../components/Foo";`,
    messageId: "upwardImport",
    hasOptions: true,
  },
  {
    rule: "local/layer-direction",
    shape: "dynamic import",
    filePath: "src/lib/voice/livekitSession.ts",
    code: `async function f() { return import("@pages/MainPage"); }`,
    messageId: "upwardImport",
    hasOptions: true,
  },
];

describe("custom lint-rule canaries", () => {
  for (const canary of CANARIES) {
    const shape = canary.shape === undefined ? "" : ` (${canary.shape})`;
    it(`${canary.rule}${shape} is enabled at ${canary.filePath} and fires on its canary shape`, async () => {
      // Scope check: a rule that a refactor scoped away is disabled here, and
      // an inert rule is exactly the failure this canary exists to catch.
      const config = await eslint.calculateConfigForFile(path.join(clientRoot, canary.filePath));
      const configured = config?.rules?.[canary.rule];
      if (canary.hasOptions) {
        expect(configured?.[0], `${canary.rule} not enabled at ${canary.filePath}`).toBe(
          canary.severity ?? 2,
        );
        expect(configured?.[1], `${canary.rule} lost its options`).toBeDefined();
      } else {
        expect(configured, `${canary.rule} not enabled at ${canary.filePath}`).toEqual([
          canary.severity ?? 2,
        ]);
      }

      // The filename is passed so a path-scoped rule (layer-direction) sees
      // the module it guards; the other rules ignore it.
      const fired = linter.verify(
        canary.code,
        [{ ...flatConfig, rules: { [canary.rule]: "error" } }],
        path.join(clientRoot, canary.filePath),
      );
      expect(
        fired.map((m) => m.messageId),
        `${canary.rule} did not fire on its canary shape at ${canary.filePath}`,
      ).toContain(canary.messageId);
    });
  }

  it("every rule exported by eslint-rules.js has a canary", () => {
    const canaried = new Set(CANARIES.map((c) => c.rule));
    const missing = Object.keys(localRules.rules)
      .map((name) => `local/${name}`)
      .filter((id) => !canaried.has(id));
    expect(missing, `rules without a canary: ${missing.join(", ")}`).toEqual([]);
  });

  it("every canary names a rule that still exists", () => {
    const known = new Set(Object.keys(localRules.rules).map((name) => `local/${name}`));
    const stale = CANARIES.map((c) => c.rule).filter((id) => !known.has(id));
    expect(stale, `canaries for removed rules: ${stale.join(", ")}`).toEqual([]);
  });

  it("every canary filePath is a real production module", () => {
    for (const canary of CANARIES) {
      const abs = path.join(clientRoot, canary.filePath);
      expect(() => readFileSync(abs, "utf8"), canary.filePath).not.toThrow();
    }
  });
});

// The import bans are core rules, so the rule entries come from the real
// config at that path but run through the flat Linter. eslint.lintText would
// build the type-aware program for the whole project on its first call, which
// can run past 60 s on a loaded CI runner and proves nothing about these rules.
const IMPORT_BANS = ["no-restricted-imports", "no-restricted-syntax"] as const;

async function restricted(code: string, filePath: string): Promise<string[]> {
  const abs = path.join(clientRoot, filePath);
  const config = await eslint.calculateConfigForFile(abs);
  const rules = Object.fromEntries(
    IMPORT_BANS.filter((id) => config?.rules?.[id] !== undefined).map((id) => [
      id,
      config.rules[id],
    ]),
  );
  return linter
    .verify(code, [{ files: ["**/*.ts"], languageOptions: flatConfig.languageOptions, rules }], abs)
    .map((m) => String(m.ruleId))
    .filter((id) => (IMPORT_BANS as readonly string[]).includes(id));
}

// 5.4e: a *.view.ts draws from a row model and imports no store.
describe("view-file store ban", () => {
  const VIEW = "src/features/members/memberRow.view.ts";
  const NON_VIEW = "src/features/members/memberRowModel.ts";

  it("flags a static store import in a view file", async () => {
    expect(
      await restricted(`import { membersStore } from "@stores/members.store";`, VIEW),
    ).toContain("no-restricted-imports");
    expect(await restricted(`import { x } from "../../stores/ui.store";`, VIEW)).toContain(
      "no-restricted-imports",
    );
    expect(await restricted(`import { x } from "@lib/voice/livekitSession";`, VIEW)).toContain(
      "no-restricted-imports",
    );
    expect(await restricted(`import { x } from "../safety/store";`, VIEW)).toContain(
      "no-restricted-imports",
    );
  }, 60_000);

  it("flags a dynamic import of a store in a view file", async () => {
    expect(
      await restricted(`export const f = () => import("@stores/members.store");`, VIEW),
    ).toContain("no-restricted-syntax");
    expect(
      await restricted(`export const f = () => import("../moderation/store");`, VIEW),
    ).toContain("no-restricted-syntax");
    expect(
      await restricted(`export const f = () => import("@lib/voice/livekitSession");`, VIEW),
    ).toContain("no-restricted-syntax");
  }, 60_000);

  it("does not flag a store import outside a view file", async () => {
    expect(
      await restricted(`import { membersStore } from "@stores/members.store";`, NON_VIEW),
    ).toEqual([]);
    expect(
      await restricted(`export const f = () => import("@stores/members.store");`, NON_VIEW),
    ).toEqual([]);
  }, 60_000);
});

// 6.13b: the browser platform must stay free of native imports. The ban in
// eslint.config.js exempts only src/platform/desktop, so it already covers
// src/platform/browser; these cases fail if that exemption ever widens.
describe("browser platform native-import ban", () => {
  const BROWSER = "src/platform/browser/index.ts";
  const DESKTOP = "src/platform/desktop/appMetadata.ts";

  it("flags a static @tauri-apps import in the browser platform", async () => {
    expect(
      await restricted(
        `import { invoke } from "@tauri-apps/api/core";\nexport const x = invoke;`,
        BROWSER,
      ),
    ).toContain("no-restricted-imports");
  }, 60_000);

  it("flags a dynamic @tauri-apps import in the browser platform", async () => {
    expect(
      await restricted(`export const f = () => import("@tauri-apps/api/app");`, BROWSER),
    ).toContain("no-restricted-syntax");
  }, 60_000);

  it("still allows the desktop platform to import it", async () => {
    expect(
      await restricted(`export const f = () => import("@tauri-apps/api/app");`, DESKTOP),
    ).toEqual([]);
  }, 60_000);
});
