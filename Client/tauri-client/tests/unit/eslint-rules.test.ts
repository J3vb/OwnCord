// Tests for the custom ESLint rules in eslint-rules.js that enforce three of
// the invariants documented in prose in CLAUDE.md. Each `describe` block
// covers one rule: `valid` cases are real shapes from the actual codebase
// that must NOT be flagged, `invalid` cases are the historical bug shape
// each rule exists to catch (see eslint-rules.js for the git-history context
// on each one).
import { describe, it } from "vitest";
import { RuleTester } from "eslint";
// eslint-rules.js is plain JS with no type declarations; the import below is
// only used to drive RuleTester, not type-checked against a `.d.ts`.
// @ts-expect-error -- no type declarations for the plain-JS rules module
import localRules from "../../eslint-rules.js";

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

describe("eslint-rules", () => {
  it("no-leave-voice-when-superseded", () => {
    ruleTester.run(
      "no-leave-voice-when-superseded",
      localRules.rules["no-leave-voice-when-superseded"],
      {
        valid: [
          // Entry-point cleanup before starting a new attempt — not a
          // supersession check, so leaveVoice() here is fine.
          `class LiveKitSession {
            connectAndSetup() {
              if (this._room !== null) this.leaveVoice(false);
            }
          }`,
          // Reconnect give-up path: the guard returns early on supersession;
          // leaveVoice() runs afterward as a sibling statement, never nested
          // inside the superseded branch.
          `class LiveKitSession {
            async attemptAutoReconnect(signal, channelId) {
              if (this.reconnectSuperseded(signal, channelId)) {
                log.info("give up — superseded");
                return;
              }
              this.leaveVoice(true);
              leaveVoiceChannel();
            }
          }`,
          // Positive-confirmed pattern: leaveVoice() only runs when the
          // generation check confirms this attempt is STILL current.
          `class LiveKitSession {
            async connectAndSetup(myGeneration) {
              if (
                this._state.type === "connecting" &&
                this._state.joinGeneration === myGeneration &&
                this._state.pendingJoin === null
              ) {
                this.leaveVoice(true);
                leaveVoiceChannel();
              }
              return false;
            }
          }`,
          // isStateConnected() checkpoint: the safe cleanup scopes to the
          // attempt's own room instead of calling the global leaveVoice().
          `class LiveKitSession {
            async connectAndSetup(channelId, localRoom) {
              if (!this.isStateConnected(channelId)) {
                this.disconnectSupersededLocalRoom(localRoom);
                return "superseded";
              }
            }
          }`,
          // e2ee-timeout shape: a nested joinGeneration guard returns early;
          // leaveVoice() is a sibling statement after it, not nested inside.
          `class LiveKitSession {
            async connectAndSetup(channelId, myGeneration, keyExchangeOk) {
              if (!keyExchangeOk) {
                if (this._state.type !== "connecting" || this._state.joinGeneration !== myGeneration) {
                  return "superseded";
                }
                this.leaveVoice(true);
                leaveVoiceChannel();
                return false;
              }
            }
          }`,
        ],
        invalid: [
          // The historical bug shape: leaveVoice() called directly inside a
          // reconnectSuperseded() branch — tears down whatever session
          // currently owns _state, which may be a newer, live attempt.
          {
            code: `class LiveKitSession {
              async attemptAutoReconnect(signal, channelId) {
                if (this.reconnectSuperseded(signal, channelId)) {
                  this.leaveVoice(true);
                  return;
                }
              }
            }`,
            errors: [{ messageId: "unsafeLeaveVoice" }],
          },
          // Same bug, via the negated isStateConnected() guard (this is
          // exactly what checkpoints 3-5 regressed to before the fix that
          // introduced disconnectSupersededLocalRoom).
          {
            code: `class LiveKitSession {
              async connectAndSetup(channelId, localRoom) {
                if (!this.isStateConnected(channelId)) {
                  this.leaveVoice(false);
                  return "superseded";
                }
              }
            }`,
            errors: [{ messageId: "unsafeLeaveVoice" }],
          },
        ],
      },
    );
  });

  it("e2ee-epoch-needs-keypair-check", () => {
    ruleTester.run(
      "e2ee-epoch-needs-keypair-check",
      localRules.rules["e2ee-epoch-needs-keypair-check"],
      {
        valid: [
          // handleOfferInner / handleAnnounceInner's real (fixed) guard:
          // epoch AND keypair identity checked together.
          `class E2EEManager {
            async handleOfferInner(keypair, epochBefore) {
              if (this._e2eeEpoch !== epochBefore || this._ecdhKeyPair !== keypair) {
                return;
              }
            }
          }`,
          // distributeRoomKey's guard: keypair (+ room key) only, no epoch
          // involved at all — the rule must not demand an epoch check here.
          `class E2EEManager {
            async distributeRoomKey(keypair, roomKey) {
              if (this._ecdhKeyPair !== keypair || this._roomKey !== roomKey) {
                return;
              }
            }
          }`,
          // Unrelated condition — no epoch, no keypair.
          `class E2EEManager {
            foo(x) {
              if (x > 0) {
                return true;
              }
            }
          }`,
        ],
        invalid: [
          // The historical bug: epoch-only staleness check. A non-key-holder
          // never bumps the epoch, so this cannot detect a torn-down-then-
          // restarted session.
          {
            code: `class E2EEManager {
              async handleOfferInner(epochBefore) {
                if (this._e2eeEpoch !== epochBefore) {
                  return;
                }
              }
            }`,
            errors: [{ messageId: "missingKeypairCheck" }],
          },
        ],
      },
    );
  });

  it("e2ee-verified-status-literal", () => {
    ruleTester.run(
      "e2ee-verified-status-literal",
      localRules.rules["e2ee-verified-status-literal"],
      {
        valid: [
          `setPeerVerification({ userId, status: "verified", safetyNumber });`,
          `class E2EEManager {
          f(myGeneration, userId) {
            this.setPeerVerificationIfCurrent(myGeneration, { userId, status: "mismatch", safetyNumber: null });
          }
        }`,
          `class E2EEManager {
          f(myGeneration, userId) {
            this.setPeerVerificationIfCurrent(myGeneration, { userId, status: "unverified", safetyNumber: null });
          }
        }`,
        ],
        invalid: [
          // A regression that derives the status instead of asserting it
          // inline at a hand-verified call site.
          {
            code: `class E2EEManager {
            f(myGeneration, userId, safetyNumber, ok) {
              const computedStatus = ok ? "verified" : "unverified";
              this.setPeerVerificationIfCurrent(myGeneration, { userId, status: computedStatus, safetyNumber });
            }
          }`,
            errors: [{ messageId: "dynamicStatus" }],
          },
          {
            code: `setPeerVerification({ userId, status: computeStatus(ok), safetyNumber: null });`,
            errors: [{ messageId: "dynamicStatus" }],
          },
        ],
      },
    );
  });

  it("no-identity-scope-fallback", () => {
    ruleTester.run("no-identity-scope-fallback", localRules.rules["no-identity-scope-fallback"], {
      valid: [
        // The real (fixed) pattern at both call sites: a missing user id
        // aborts instead of substituting a placeholder scope.
        `async function ensureIdentityKeyPair(host) {
          const myUserId = authStore.getState().user?.id;
          if (myUserId === undefined) return null;
          return await getOrCreateIdentityKeyPair(host, myUserId);
        }`,
        // Unrelated call with the same shape but a different callee — must
        // not be flagged just because it also takes two args.
        `someOtherFunction(host, userId ?? 0);`,
      ],
      invalid: [
        {
          code: `async function ensureIdentityKeyPair(host, userId) {
            return await getOrCreateIdentityKeyPair(host, userId ?? 0);
          }`,
          errors: [{ messageId: "placeholderFallback" }],
        },
        {
          code: `getOrCreateIdentityKeyPair(host, userId || 0);`,
          errors: [{ messageId: "placeholderFallback" }],
        },
      ],
    });
  });

  it("no-store-write-in-ws-on", () => {
    ruleTester.run("no-store-write-in-ws-on", localRules.rules["no-store-write-in-ws-on"], {
      valid: [
        // A store mutator called from a plain UI callback (not a ws.on()
        // handler at all) is unaffected.
        `import { setActiveChannel } from "@stores/channels.store";
        function onCancel() {
          setActiveChannel(null);
        }`,
        // A ws.on() handler outside dispatcher.ts that only READS a store
        // (channelsStore.getState()) to drive page-local UI — this is the
        // real ChannelController.ts shape and must stay legal.
        `import { channelsStore } from "@stores/channels.store";
        ws.on("chat_send_ok", (payload, id) => {
          const ch = channelsStore.getState().channels.get(1);
          startSlowMode(ch.slowMode);
        });`,
        // A locally-defined function that happens to match the mutator-verb
        // naming convention, but was never imported from a stores/ module —
        // proves the rule keys off the import source, not the name alone.
        `function setLocalThing() {}
        ws.on("ready", () => {
          setLocalThing();
        });`,
      ],
      invalid: [
        {
          code: `import { setActiveChannel } from "@stores/channels.store";
          ws.on("chat_send_ok", () => {
            setActiveChannel(null);
          });`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
        // Reached indirectly through a nested .then() inside the callback —
        // still "driven by this ws event", so still flagged.
        {
          code: `import { updateUser } from "@stores/auth.store";
          ws.on("user_update", () => {
            somePromise.then(() => {
              updateUser({ username: "x" });
            });
          });`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
      ],
    });
  });
});
