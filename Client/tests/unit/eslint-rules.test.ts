// Tests for the custom ESLint rules in eslint-rules.js that enforce three of
// the invariants documented in prose in CLAUDE.md. Each `describe` block
// covers one rule: `valid` cases are real shapes from the actual codebase
// that must NOT be flagged, `invalid` cases are the historical bug shape
// each rule exists to catch (see eslint-rules.js for the git-history context
// on each one).
import path from "node:path";
import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
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
          // The extracted livekitReconnect.ts shape: attemptAutoReconnect is a
          // free function, supersession is a local `superseded()` closure, and
          // teardown goes through `deps.leaveVoice()`. The give-up call is a
          // sibling statement after the early return, so this must stay clean.
          `async function attemptAutoReconnect(deps, signal, channelId, owner) {
            const superseded = () => reconnectSuperseded(signal, channelId, owner, deps.getState());
            if (superseded()) {
              log.info("Auto-reconnect give-up skipped — superseded");
              return;
            }
            deps.leaveVoice();
            leaveVoiceChannel();
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
          // Same bug in the extracted livekitReconnect.ts vocabulary: the
          // local `superseded()` closure plus `deps.leaveVoice()`. Before the
          // matcher was widened, neither receiver was recognised and the rule
          // was blind inside the file that owns the reconnect loop.
          {
            code: `async function attemptAutoReconnect(deps, signal, channelId, owner) {
              const superseded = () => reconnectSuperseded(signal, channelId, owner, deps.getState());
              if (superseded()) {
                deps.leaveVoice();
                return;
              }
            }`,
            errors: [{ messageId: "unsafeLeaveVoice" }],
          },
          // And via the negated isStateConnected() checkpoint on `deps`.
          {
            code: `async function attemptAutoReconnect(deps, channelId, newRoom) {
              if (!deps.isStateConnected(channelId, newRoom)) {
                deps.leaveVoice();
                return;
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
        // A callback passed in as a parameter runs later, not in this function.
        `import { setLoading } from "@stores/ui.store";
        function bind(handler) {
          setLoading(true);
          ws.on("x", handler);
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
        // A feature-local store instance is READ, not called — `safetyStore`
        // is imported from a features/*/store module but only its .getState()
        // is reached, and a store instance is never recorded as a mutator
        // (OC-0478).
        {
          filename: "src/pages/Probe.ts",
          code: `import { safetyStore } from "../features/safety/store";
          ws.on("mod_action", () => {
            safetyStore.getState();
          });`,
        },
        // A bare "./store" outside features/ is not a domain store: from lib/
        // it resolves to src/lib/store, so a mutator-named import is not
        // recorded.
        {
          filename: "src/lib/Probe.ts",
          code: `import { applyFrame } from "./store";
          ws.on("dm_request", (p) => applyFrame(p, true));`,
        },
        // Native certificate listeners are not server frames; main.ts writes
        // a transient error from them on purpose, so they stay unmatched.
        `import { setTransientError } from "@stores/auth.store";
        ws.onCertFirstUse(() => { setTransientError("x"); });
        ws.onCertMismatch(() => { setTransientError("x"); });`,
        // A receiver that is not a WebSocket client is not a ws subscription.
        `import { setActiveChannel } from "@stores/channels.store";
        emitter.on("x", () => { setActiveChannel(1); });
        this.bus.on("x", () => { setActiveChannel(1); });`,
        // A named handler nothing registers on the socket is just a function.
        `import { setActiveChannel } from "@stores/channels.store";
        function notAHandler() { setActiveChannel(1); }
        ws.on("x", () => {});`,
        // Reads through getState() inside a handler stay legal, as does a
        // setState on something that is not an imported store.
        `import { uiStore } from "@stores/ui.store";
        ws.onStateChange(() => {
          const open = uiStore.getState().settingsOpen;
          localThing.setState(open);
          localThing.getState().addItem(open);
        });`,
        // A getState() action whose name is not a mutator verb is a read.
        `import { channelsStore } from "@stores/channels.store";
        ws.on("x", () => { channelsStore.getState().channelById(1); });`,
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
        // A factory's returned name resolves in the factory's own scope.
        {
          code: `import { setX } from "@stores/ui.store";
          function make() { const h = () => setX(1); return h; }
          ws.on("x", make());`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
        // OC-0478: the B9 domain stores live under features/*/store.ts, not
        // stores/, and several of their mutators fall outside the
        // set*/add*/... prefix list — applySnapshot, noteQueueChange,
        // applyAppealStatus. A page-local ws.on that writes any of them is
        // the same second-writer violation and must be flagged.
        {
          filename: "src/pages/Probe.ts",
          code: `import { applyFrame } from "../features/message-requests/store";
          ws.on("dm_request", (p) => applyFrame(p, true));`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
        // The same store reached from a sibling feature ("../<name>/store")
        // and from inside its own feature ("./store").
        {
          filename: "src/features/navigation/Probe.ts",
          code: `import { applyFrame } from "../message-requests/store";
          ws.on("dm_request", (p) => applyFrame(p, true));`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
        {
          filename: "src/features/message-requests/Probe.ts",
          code: `import { applyFrame } from "./store";
          ws.on("dm_request", (p) => applyFrame(p, true));`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
        {
          filename: "src/main.ts",
          code: `import { applySnapshot, beginSnapshot } from "./features/message-requests/store";
          ws.on("ready", () => { beginSnapshot(); applySnapshot([], token); });`,
          errors: [
            { messageId: "storeWriteOutsideDispatcher" },
            { messageId: "storeWriteOutsideDispatcher" },
          ],
        },
        {
          filename: "src/pages/Probe.ts",
          code: `import { noteQueueChange } from "../features/moderation/store";
          ws.on("mod_queue", () => noteQueueChange());`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
        {
          filename: "src/pages/Probe.ts",
          code: `import { addNotice, setActiveTimeout } from "../features/safety/store";
          ws.on("mod_action", (p) => { addNotice(1, "x", "y"); setActiveTimeout(null); });`,
          errors: [
            { messageId: "storeWriteOutsideDispatcher" },
            { messageId: "storeWriteOutsideDispatcher" },
          ],
        },
        // Wider receivers: the client held as `this.ws`, `deps.ws` or
        // `wsClient`, and reached through an optional chain.
        ...["this.ws", "deps.ws", "wsClient", "ws?"].map((receiver) => ({
          code: `import { setActiveChannel } from "@stores/channels.store";
          ${receiver}.on("x", () => { setActiveChannel(1); });`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        })),
        // Wider methods: the other server-driven subscriptions on the client.
        ...["onStateChange", "onSendFailure"].map((method) => ({
          code: `import { setActiveChannel } from "@stores/channels.store";
          ws.${method}(() => { setActiveChannel(1); });`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        })),
        // A store written without a named mutator: setState on the instance.
        {
          code: `import { authStore } from "@stores/auth.store";
          ws.on("x", () => { authStore.setState((prev) => ({ ...prev, token: null })); });`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
        {
          filename: "src/pages/Probe.ts",
          code: `import { safetyStore } from "../features/safety/store";
          ws.on("mod_action", () => { safetyStore.setState({}); });`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
        // A mutator reached through getState().
        {
          code: `import { messagesStore } from "@stores/messages.store";
          ws.on("x", (p) => { messagesStore.getState().addMessage(p); });`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
        // Named callbacks: a function declaration, a const arrow, and a local
        // factory that returns the handler.
        {
          code: `import { setActiveChannel } from "@stores/channels.store";
          function onX() { setActiveChannel(1); }
          ws.on("x", onX);`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
        {
          code: `import { setActiveChannel } from "@stores/channels.store";
          ws.on("x", onX);
          const onX = () => { setActiveChannel(1); };`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
        {
          code: `import { setActiveChannel } from "@stores/channels.store";
          function makeHandler(id) { return () => { setActiveChannel(id); }; }
          ws.on("x", makeHandler(1));`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
        {
          code: `import { setActiveChannel } from "@stores/channels.store";
          const makeHandler = (id) => () => setActiveChannel(id);
          const h = makeHandler(1);
          ws.on("x", h);`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
        // A handler wrapped in a call, as dispatcher-style `unsubs.push(ws.on(...))`.
        {
          code: `import { setActiveChannel } from "@stores/channels.store";
          function onX() { setActiveChannel(1); }
          unsubs.push(ws.on("x", onX));`,
          errors: [{ messageId: "storeWriteOutsideDispatcher" }],
        },
      ],
    });
  });

  it("invoke-needs-try-catch", () => {
    ruleTester.run("invoke-needs-try-catch", localRules.rules["invoke-needs-try-catch"], {
      valid: [
        // The wrapped shape the platform modules use: the awaited command
        // sits in a try block that has a catch.
        `async function save() {
          try {
            await invoke("save_settings", { key: "k" });
          } catch (err) {
            log.warn("save failed", err);
          }
        }`,
        // The dynamic-import form, with the import inside the same try.
        `async function load() {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            return await invoke("get_settings");
          } catch {
            return null;
          }
        }`,
        // The await still consumes the promise through a .then(ok) hop or a
        // promise combinator, so the surrounding try/catch sees the rejection.
        `async function f() {
          try { await invoke("a").then(onOk); } catch (err) { log.warn("x", err); }
        }`,
        `async function f() {
          try { await Promise.all([invoke("a"), invoke("b")]); } catch (err) { log.warn("x", err); }
        }`,
        `invoke("a").then(onOk, (err) => log.warn("x", err));`,
        // A promise chain that ends in a handler.
        `invoke("stop_livekit_proxy").catch((err) => log.warn("stop failed", err));`,
        `invoke("stop_livekit_proxy").then(onOk, onFail);`,
        // A wrapper that injects `invoke` and owns the error handling, as
        // externalContent.ts's call() does: the parameter is the wrapper's.
        `const preview = () => call((invoke) => invoke("external_preview", { url }));`,
        `async function f() {
          try { await tauriInvoke("ws_disconnect"); } catch (err) { log.warn("x", err); }
        }`,
        // Something else named like it is not the Tauri command.
        `async function f() { await other("x"); await client.invoke("x"); }`,
        // An inner try without a catch defers to the enclosing try's catch.
        `async function f() {
          try { try { await invoke("a"); } finally { cleanup(); } } catch (err) { log.warn("x", err); }
        }`,
      ],
      invalid: [
        {
          code: `async function f() { await invoke("frontend_ready"); }`,
          errors: [{ messageId: "bareInvoke" }],
        },
        // The destructured dynamic-import shape (notifications.ts), no try.
        {
          code: `async function f() {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("set_unread_badge", { count });
          }`,
          errors: [{ messageId: "bareInvoke" }],
        },
        // Not awaited: the rejection escapes the try.
        {
          code: `async function f() { try { invoke("a"); } catch {} }`,
          errors: [{ messageId: "bareInvoke" }],
        },
        {
          code: `async function f() { try { void invoke("a"); } catch {} }`,
          errors: [{ messageId: "bareInvoke" }],
        },
        // A try that has no catch lets the rejection through.
        {
          code: `async function f() {
            try { await invoke("a"); } finally { cleanup(); }
          }`,
          errors: [{ messageId: "bareInvoke" }],
        },
        // The catch block and the finally block are not protected by their own try.
        {
          code: `async function f() {
            try { await a(); } catch { await invoke("b"); }
          }`,
          errors: [{ messageId: "bareInvoke" }],
        },
        {
          code: `async function f() {
            try { await a(); } catch {} finally { await invoke("b"); }
          }`,
          errors: [{ messageId: "bareInvoke" }],
        },
        // Returned without await: the rejection leaves the try block.
        {
          code: `async function f() {
            try { return invoke("a"); } catch { return null; }
          }`,
          errors: [{ messageId: "bareInvoke" }],
        },
        // A callback defined inside a try runs after the try has exited.
        {
          code: `function f() {
            try { setTimeout(() => invoke("a"), 0); } catch {}
          }`,
          errors: [{ messageId: "bareInvoke" }],
        },
        // A .catch / .then whose rejection callback is absent or a literal
        // nothing (`undefined`, `null`, `void 0`) installs no handler.
        ...[
          `invoke("a").catch();`,
          `invoke("a").catch(undefined);`,
          `invoke("a").catch(null);`,
          `invoke("a").then(onOk, undefined);`,
          `invoke("a").then(onOk, null);`,
          `invoke("a").then(onOk, void 0);`,
        ].map((code) => ({ code, errors: [{ messageId: "bareInvoke" }] })),
        // An await that does not consume the invoke promise: awaiting an array
        // (or any value that merely contains the promise) resolves at once.
        ...[
          `async function f() { try { await [invoke("a")]; } catch {} }`,
          `async function f() { try { await { p: invoke("a") }; } catch {} }`,
          `async function f() { try { await Promise.resolve([invoke("a")]); } catch {} }`,
        ].map((code) => ({ code, errors: [{ messageId: "bareInvoke" }] })),
        // A .then with no rejection handler, and a voided call.
        {
          code: `invoke("a").then(onOk);`,
          errors: [{ messageId: "bareInvoke" }],
        },
        {
          code: `void invoke("a");`,
          errors: [{ messageId: "bareInvoke" }],
        },
        // socket.ts's alias for the resolved command function.
        {
          code: `async function f() { await tauriInvoke("accept_cert_fingerprint", { host }); }`,
          errors: [{ messageId: "bareInvoke" }],
        },
        // The object-literal service shape (nativeVoiceService.ts).
        {
          code: `const service = { clearRoomKey: () => invoke("native_voice_clear_key") };`,
          errors: [{ messageId: "bareInvoke" }],
        },
      ],
    });
  });

  it("no-raw-html-sink", () => {
    ruleTester.run("no-raw-html-sink", localRules.rules["no-raw-html-sink"], {
      valid: [
        `el.textContent = text;`,
        `el.replaceChildren();`,
        `el.setAttribute("class", "x");`,
        `el.setAttribute(name, html);`,
        `const html = el.innerHTML;`,
        `logger.write("x");`,
        `el.srcdoc;`,
      ],
      invalid: [
        { code: `el.innerHTML = "";`, errors: [{ messageId: "htmlSink" }] },
        { code: `el.innerHTML += html;`, errors: [{ messageId: "htmlSink" }] },
        { code: `el["innerHTML"] = html;`, errors: [{ messageId: "htmlSink" }] },
        { code: `this.root.outerHTML = html;`, errors: [{ messageId: "htmlSink" }] },
        { code: `frame.srcdoc = html;`, errors: [{ messageId: "htmlSink" }] },
        { code: `el.insertAdjacentHTML("beforeend", html);`, errors: [{ messageId: "htmlSink" }] },
        { code: `document.write(html);`, errors: [{ messageId: "htmlSink" }] },
        { code: `document.writeln(html);`, errors: [{ messageId: "htmlSink" }] },
        { code: `frame.setAttribute("srcdoc", html);`, errors: [{ messageId: "htmlSink" }] },
        { code: `frame.setAttribute("SrcDoc", html);`, errors: [{ messageId: "htmlSink" }] },
        { code: "el[`innerHTML`] = html;", errors: [{ messageId: "htmlSink" }] },
        { code: "frame.setAttribute(`srcdoc`, html);", errors: [{ messageId: "htmlSink" }] },
      ],
    });
  });

  it("subscription-result-kept", () => {
    ruleTester.run("subscription-result-kept", localRules.rules["subscription-result-kept"], {
      valid: [
        `const off = store.subscribe(fn);`,
        `const stop = authStore.subscribeSelector(sel, fn);`,
        `unsubs.push(ws.on("x", fn));`,
        `unsubs.push(onAuthCleared(reset));`,
        `function f() { return store.subscribe(fn); }`,
        `const f = () => onAuthCleared(reset);`,
        `register(store.subscribe(fn));`,
        `this.off = this.ws.on("x", fn);`,
        `appZoom.subscribe(paint, signal);`,
        `appZoom.subscribe(paint, this.abort.signal);`,
        `emitter.on("x", fn);`,
        `button.addEventListener("click", fn);`,
        `void store.subscribe(fn); // app-lifetime`,
        `// app-lifetime hook\nvoid onAuthCleared(reset);`,
      ],
      invalid: [
        { code: `store.subscribe(fn);`, errors: [{ messageId: "discarded" }] },
        { code: `subscribe(fn);`, errors: [{ messageId: "discarded" }] },
        { code: `authStore.subscribeSelector(sel, fn);`, errors: [{ messageId: "discarded" }] },
        { code: `ws.on("x", fn);`, errors: [{ messageId: "discarded" }] },
        { code: `this.ws.on("x", fn);`, errors: [{ messageId: "discarded" }] },
        { code: `onAuthCleared(reset);`, errors: [{ messageId: "discarded" }] },
        { code: `store?.subscribe(fn);`, errors: [{ messageId: "discarded" }] },
        { code: `store.subscribe?.(fn);`, errors: [{ messageId: "discarded" }] },
        {
          code: `async function f() { await store.subscribe(fn); }`,
          errors: [{ messageId: "discarded" }],
        },
        { code: `void onAuthCleared(reset);`, errors: [{ messageId: "voidNeedsReason" }] },
        {
          code: `// unrelated\n\nvoid store.subscribe(fn);`,
          errors: [{ messageId: "voidNeedsReason" }],
        },
      ],
    });
  });

  it("layer-direction", () => {
    // Type syntax needs the TypeScript parser. Filenames are real src/ paths:
    // the rule keys on the importer's layer, never on type information.
    const tsTester = new RuleTester({
      languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: "module" },
    });
    const src = (rel: string) => path.resolve(__dirname, "../../src", rel);
    const lib = src("lib/fixture.ts");
    const error = (importer: string, target: string, fromLayer: string, toLayer: string) => ({
      messageId: "upwardImport",
      data: { importer, target, fromLayer, toLayer },
    });

    tsTester.run("layer-direction", localRules.rules["layer-direction"], {
      valid: [
        // Same rank (lib and platform are peers), lower rank, and within a layer.
        { code: `import { a } from "../platform/desktop";`, filename: lib },
        { code: `import { a } from "./logger";`, filename: lib },
        { code: `import "@styles/app.css";`, filename: src("components/Foo.ts") },
        { code: `import { a } from "@lib/dom";`, filename: src("stores/auth.store.ts") },
        {
          code: `import { a } from "../components/Foo";`,
          filename: src("features/voice/x.ts"),
        },
        // main.ts and app/ sit above everything, including platform/.
        { code: `import { d } from "./platform/desktop";`, filename: src("main.ts") },
        { code: `import { p } from "@pages/MainPage";`, filename: src("app/router.ts") },
        // Type-only forms are not counted: emit drops them.
        { code: `import type { X } from "@pages/MainPage";`, filename: lib },
        { code: `import { type X, type Y } from "@pages/MainPage";`, filename: lib },
        { code: `export type { X } from "@stores/auth.store";`, filename: lib },
        { code: `export { type X } from "@stores/auth.store";`, filename: lib },
        { code: `export type * from "@stores/auth.store";`, filename: lib },
        { code: `export type T = typeof import("@pages/MainPage");`, filename: lib },
        // Local declarations and package imports have no layer.
        { code: `export const x = 1; export { x as y };`, filename: lib },
        { code: `import { a } from "livekit-client";`, filename: lib },
        { code: `const m = await import(name);`, filename: lib },
        // A colocated test file is exempt.
        { code: `import { p } from "@pages/MainPage";`, filename: src("lib/fixture.test.ts") },
        // Outside src/ and a file with no layer.
        {
          code: `import { p } from "../../src/pages/MainPage";`,
          filename: path.resolve(__dirname, "../helpers/fixture.ts"),
        },
        { code: `import { a } from "@stores/auth.store";`, filename: src("vite-env.d.ts") },
        // A relative specifier that leaves src/ is not a layer.
        { code: `import { h } from "../../tests/helpers/x";`, filename: src("lib/fixture.ts") },
        // Listed edges are not reported, by alias or by relative path (same key).
        {
          code: `import { a } from "@stores/auth.store";`,
          filename: lib,
          options: [{ baseline: { debt: { "lib/fixture.ts": { "stores/auth.store.ts": 1 } } } }],
        },
        {
          code: `import { a } from "../stores/auth.store";`,
          filename: lib,
          options: [{ baseline: { debt: { "lib/fixture.ts": { "stores/auth.store.ts": 1 } } } }],
        },
        {
          code: `import { a } from "@stores/auth.store"; export { b } from "../stores/auth.store";`,
          filename: lib,
          options: [
            {
              baseline: {
                sanctioned: { "lib/fixture.ts": { "stores/auth.store.ts": 1 } },
                debt: { "lib/fixture.ts": { "stores/auth.store.ts": 1 } },
              },
            },
          ],
        },
      ],
      invalid: [
        {
          code: `import { f } from "../features/voice/sessionState";`,
          filename: lib,
          errors: [error("lib/fixture.ts", "features/voice/sessionState.ts", "lib", "features")],
        },
        {
          code: `import { s } from "@stores/voice.store";`,
          filename: lib,
          errors: [error("lib/fixture.ts", "stores/voice.store.ts", "lib", "stores")],
        },
        {
          code: `import { s } from "../stores/voice.store";`,
          filename: lib,
          errors: [error("lib/fixture.ts", "stores/voice.store.ts", "lib", "stores")],
        },
        {
          code: `import { f } from "../features/voice/joinBackoff";`,
          filename: src("stores/voice.store.ts"),
          errors: [
            error("stores/voice.store.ts", "features/voice/joinBackoff.ts", "stores", "features"),
          ],
        },
        {
          code: `import { f } from "../../stores/auth.store";`,
          filename: src("platform/desktop/fixture.ts"),
          errors: [
            error("platform/desktop/fixture.ts", "stores/auth.store.ts", "platform", "stores"),
          ],
        },
        {
          code: `import { s } from "../features/safety/store";`,
          filename: src("i18n/fixture.ts"),
          errors: [error("i18n/fixture.ts", "features/safety/store.ts", "i18n", "features")],
        },
        // export ... from and export * are runtime edges.
        {
          code: `export { s } from "@stores/voice.store";`,
          filename: lib,
          errors: [error("lib/fixture.ts", "stores/voice.store.ts", "lib", "stores")],
        },
        {
          code: `export * from "@stores/voice.store";`,
          filename: lib,
          errors: [error("lib/fixture.ts", "stores/voice.store.ts", "lib", "stores")],
        },
        // A mixed list is a value import.
        {
          code: `import { type X, y } from "@stores/voice.store";`,
          filename: lib,
          errors: [error("lib/fixture.ts", "stores/voice.store.ts", "lib", "stores")],
        },
        // A side-effect import is a runtime edge.
        {
          code: `import "@stores/voice.store";`,
          filename: lib,
          errors: [error("lib/fixture.ts", "stores/voice.store.ts", "lib", "stores")],
        },
        // A dynamic import() is a runtime edge too, in any position.
        {
          code: `const m = await import("@pages/MainPage");`,
          filename: lib,
          errors: [error("lib/fixture.ts", "pages/MainPage.ts", "lib", "pages")],
        },
        {
          code: `const load = () => import("../features/voice/native/screenPicker");`,
          filename: lib,
          errors: [
            error("lib/fixture.ts", "features/voice/native/screenPicker.ts", "lib", "features"),
          ],
        },
        // features -> app, only reachable by a relative path (there is no @app alias).
        {
          code: `import { x } from "../../app/session";`,
          filename: src("features/x/y.ts"),
          errors: [error("features/x/y.ts", "app/session.ts", "features", "app")],
        },
        {
          code: `import { x } from "../app/session";`,
          filename: src("components/Foo.ts"),
          errors: [error("components/Foo.ts", "app/session.ts", "components", "app")],
        },
        {
          code: `import { p } from "@pages/MainPage";`,
          filename: src("components/Foo.ts"),
          errors: [error("components/Foo.ts", "pages/MainPage.ts", "components", "pages")],
        },
        // Count-keyed: a second site beyond the listed count is reported, the
        // first is covered. The baseline never lists another importer's edge.
        {
          code: `import { a } from "@stores/auth.store"; export { b } from "../stores/auth.store";`,
          filename: lib,
          options: [{ baseline: { debt: { "lib/fixture.ts": { "stores/auth.store.ts": 1 } } } }],
          errors: [
            { ...error("lib/fixture.ts", "stores/auth.store.ts", "lib", "stores"), column: 41 },
          ],
        },
        {
          code: `import { a } from "@stores/auth.store";`,
          filename: lib,
          options: [{ baseline: { debt: { "lib/other.ts": { "stores/auth.store.ts": 1 } } } }],
          errors: [error("lib/fixture.ts", "stores/auth.store.ts", "lib", "stores")],
        },
        // A relative filename resolves against Client/.
        {
          code: `import { s } from "@stores/voice.store";`,
          filename: "src/lib/fixture.ts",
          errors: [error("lib/fixture.ts", "stores/voice.store.ts", "lib", "stores")],
        },
      ],
    });
  });
});
