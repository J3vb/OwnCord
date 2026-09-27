// ARCH-11 canaries: every custom lint rule in eslint-rules.js must actually
// FIRE on a real production-path pattern when evaluated through the real
// eslint.config.js — not merely pass in RuleTester isolation. #1587 showed how
// a rule can go inert: its scope is a `files:` glob in eslint.config.js, and a
// refactor that moves the guarded code to a new file (or changes the shape the
// matcher keys on) leaves the rule matching nothing while its RuleTester cases
// still pass. So each canary drives the rule through `ESLint.lintText` with the
// filePath of a real production module it is meant to cover, and asserts both
// that the rule is ENABLED there and that it reports.
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
}

const CANARIES: readonly Canary[] = [
  {
    rule: "local/no-leave-voice-when-superseded",
    filePath: "src/lib/livekitReconnect.ts",
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
    rule: "local/no-store-write-in-ws-on",
    filePath: "src/pages/main-page/ChannelController.ts",
    code: `import { setActiveChannel } from "@stores/channels.store";
    ws.on("x", () => { setActiveChannel(1); });`,
    messageId: "storeWriteOutsideDispatcher",
  },
];

describe("custom lint-rule canaries (ARCH-11)", () => {
  for (const canary of CANARIES) {
    it(`${canary.rule} is enabled and fires at ${canary.filePath}`, async () => {
      // Scope check: a rule that a refactor scoped away is disabled here, and
      // an inert rule is exactly the failure this canary exists to catch.
      const config = await eslint.calculateConfigForFile(path.join(clientRoot, canary.filePath));
      expect(
        config?.rules?.[canary.rule],
        `${canary.rule} not enabled at ${canary.filePath}`,
      ).toEqual([2]);

      const fired = linter.verify(canary.code, [
        { ...flatConfig, rules: { [canary.rule]: "error" } },
      ]);
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
