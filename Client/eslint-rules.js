// Custom ESLint rules that turn some of the invariants documented in prose in
// CLAUDE.md into enforced, test-covered lint rules. Each rule is scoped (via
// `files:` in eslint.config.js) to only the module(s) its invariant governs —
// see the per-rule `meta.docs.description` for the invariant it encodes and
// tests/unit/eslint-rules.test.ts for the real-code shapes it was proven
// against (both the shapes that must stay clean and the historical bug shapes
// it must catch).
//
// Plain JS, ESM, no build step — eslint.config.js imports this directly.

import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** True when `node` calls `<methodName>(...)` through any of the receivers the
 *  reconnect code uses: `this.<methodName>()` (the class form in
 *  livekitSession.ts), a bare `<methodName>()` local closure, or
 *  `<object>.<methodName>()` (the `deps.*` form in livekitReconnect.ts).
 *
 *  The extraction of attemptAutoReconnect into livekitReconnect.ts turned
 *  `this.reconnectSuperseded(...)` into a local `superseded()` closure and
 *  `this.leaveVoice()` into `deps.leaveVoice()`. Matching only `this.*` left
 *  the rule blind inside the very file that owns the reconnect loop. */
function isNamedCall(node, methodName) {
  if (node === null || node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name === methodName;
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  return callee.property.type === "Identifier" && callee.property.name === methodName;
}

/** True when `node` is a `this.<propertyName>` member access. */
function isThisMember(node, propertyName) {
  return (
    node !== null &&
    node.type === "MemberExpression" &&
    node.object.type === "ThisExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === propertyName
  );
}

function isFunctionNode(node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Rule: no-leave-voice-when-superseded
//
// Invariant (CLAUDE.md): "Voice sessions are superseded, not cancelled.
// LiveKitSession re-entry points check whether a newer attempt owns the
// shared state before tearing anything down, so cleanup in an aborted path
// must be scoped to that attempt's own room — a global leaveVoice() there
// kills the live session."
//
// livekitSession.ts encodes "this attempt was superseded" with exactly two
// guard predicates, always used the same way: `this.reconnectSuperseded(...)`
// (true = superseded) and `!this.isStateConnected(...)` (negated = true when
// superseded). Once either guard has confirmed supersession, the historical
// bug (see the fix that introduced disconnectSupersededLocalRoom /
// generation-guarded leaveVoice calls) was calling the global
// `this.leaveVoice()` inside that same branch, tearing down whichever session
// currently owns the shared state — which, once superseded, is a newer
// attempt's live session, not this one.
// ─────────────────────────────────────────────────────────────────────────

/** True when `test` (walking through &&/||) asserts "this attempt IS
 *  superseded" via one of the two named guards used throughout the file. */
function testSignalsSuperseded(test) {
  if (test === null) return false;
  if (test.type === "LogicalExpression") {
    return testSignalsSuperseded(test.left) || testSignalsSuperseded(test.right);
  }
  if (isNamedCall(test, "reconnectSuperseded")) return true;
  // livekitReconnect.ts wraps reconnectSuperseded in a local `superseded()`
  // closure that captures signal/channelId/owner — same predicate, no receiver.
  if (isNamedCall(test, "superseded")) return true;
  if (test.type === "UnaryExpression" && test.operator === "!") {
    return isNamedCall(test.argument, "isStateConnected");
  }
  return false;
}

const noLeaveVoiceWhenSuperseded = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow leaveVoice() inside a branch that already confirmed this connect/reconnect " +
        "attempt was superseded. Voice sessions are superseded, not cancelled — once reconnectSuperseded() " +
        "(or its extracted `superseded()` alias) or !isStateConnected() is true, `_state` may already " +
        "belong to a newer, live attempt, and leaveVoice() there tears that live session down instead " +
        "of the aborted one. Matches the call through any receiver: `this.`, `deps.`, or bare.",
    },
    schema: [],
    messages: {
      unsafeLeaveVoice:
        "leaveVoice() must not run once this attempt is known to be superseded — it acts on " +
        "whichever session currently owns `_state`, which may now be a newer, live attempt. Disconnect " +
        "only this attempt's own room instead (e.g. disconnectSupersededLocalRoom(localRoom) / " +
        "localRoom.disconnect()), or simply return without calling it.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isNamedCall(node, "leaveVoice")) return;
        let child = node;
        let parent = node.parent;
        while (parent) {
          if (isFunctionNode(parent)) return; // left the enclosing method — stop
          if (
            parent.type === "IfStatement" &&
            child === parent.consequent &&
            testSignalsSuperseded(parent.test)
          ) {
            context.report({ node, messageId: "unsafeLeaveVoice" });
            return;
          }
          child = parent;
          parent = parent.parent;
        }
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Rule: e2ee-epoch-needs-keypair-check
//
// Invariant (CLAUDE.md): "Anything touching livekitE2EE.ts ... must preserve
// the epoch/keypair staleness guards."
//
// Every async E2EE operation that resumes after an await re-checks it is
// still the current attempt before writing shared state. The historical bug
// (see the fix for handleOfferInner / handleAnnounceInner) compared only
// `this._e2eeEpoch !== epochBefore` — insufficient, because a non-key-holder
// never bumps the epoch, so a torn-down-then-restarted session can resume
// with the epoch unchanged in both the old and new session. The fix requires
// ALSO comparing keypair identity (`this._ecdhKeyPair !== keypair`). This
// rule requires both checks to appear together in the same guard.
// ─────────────────────────────────────────────────────────────────────────

/** True when `test` (walking through &&/||) contains `this.<prop> !== X`
 *  (in either operand order). */
function containsStrictInequality(test, prop) {
  if (test === null) return false;
  if (test.type === "LogicalExpression") {
    return containsStrictInequality(test.left, prop) || containsStrictInequality(test.right, prop);
  }
  if (test.type === "BinaryExpression" && test.operator === "!==") {
    return isThisMember(test.left, prop) || isThisMember(test.right, prop);
  }
  return false;
}

const e2eeEpochNeedsKeypairCheck = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require this._ecdhKeyPair identity checks alongside this._e2eeEpoch staleness checks. A " +
        "non-key-holder session never bumps the epoch, so an epoch-only comparison cannot detect a " +
        "torn-down-then-restarted session resuming after an await — only the keypair identity can.",
    },
    schema: [],
    messages: {
      missingKeypairCheck:
        "This staleness check compares this._e2eeEpoch but not this._ecdhKeyPair. A non-key-holder " +
        "session never advances the epoch, so this guard alone cannot detect a torn-down-then-restarted " +
        "session — add `|| this._ecdhKeyPair !== <the keypair captured before the await>` to the condition.",
    },
  },
  create(context) {
    return {
      IfStatement(node) {
        if (
          containsStrictInequality(node.test, "_e2eeEpoch") &&
          !containsStrictInequality(node.test, "_ecdhKeyPair")
        ) {
          context.report({ node: node.test, messageId: "missingKeypairCheck" });
        }
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Rule: e2ee-verified-status-literal
//
// Invariant (CLAUDE.md): "Anything touching livekitE2EE.ts ... must never
// report an unverified peer as verified."
//
// verifyPeerAnnounce's every write of peer-verification state goes through
// setPeerVerification/setPeerVerificationIfCurrent, and "verified" is reached
// exactly once, only after a real signature check. This rule keeps that
// structurally true: the `status` field at every call site must be a literal
// the author typed by hand at that call site, never a variable/expression —
// which would let a status be computed (and potentially manipulated) instead
// of asserted at the one audited call site that earned it.
// ─────────────────────────────────────────────────────────────────────────

function getCalleeName(node) {
  if (node.callee.type === "Identifier") return node.callee.name;
  if (
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property.type === "Identifier"
  ) {
    return node.callee.property.name;
  }
  return null;
}

const VERIFICATION_SETTERS = new Set(["setPeerVerification", "setPeerVerificationIfCurrent"]);

const e2eeVerifiedStatusLiteral = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require the `status` field passed to setPeerVerification/setPeerVerificationIfCurrent to be a " +
        "string literal. A peer must never be reported verified via a computed/derived status — each " +
        "verification outcome is a distinct, hand-written call site that earned its status inline.",
    },
    schema: [],
    messages: {
      dynamicStatus:
        "The `status` passed here must be a string literal ('verified' | 'changed' | 'unverified' | " +
        "'mismatch' | 'unknown'), not a computed expression. Add a new literal call site for this outcome instead of " +
        "deriving the status dynamically — that is what keeps 'verified' provably tied to a real signature check.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = getCalleeName(node);
        if (name === null || !VERIFICATION_SETTERS.has(name)) return;
        const objArg = node.arguments[node.arguments.length - 1];
        if (objArg === undefined || objArg.type !== "ObjectExpression") return;
        const statusProp = objArg.properties.find(
          (p) =>
            p.type === "Property" &&
            !p.computed &&
            p.key.type === "Identifier" &&
            p.key.name === "status",
        );
        if (statusProp === undefined) return;
        const value = statusProp.value;
        if (value.type !== "Literal" || typeof value.value !== "string") {
          context.report({ node: statusProp, messageId: "dynamicStatus" });
        }
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Rule: no-identity-scope-fallback
//
// Invariant (CLAUDE.md): "Anything touching livekitE2EE.ts or identity.ts
// must preserve the epoch/keypair staleness guards."  (Identity-scoping
// analogue: a documented, previously-real bug — see identity.ts's
// `identityKeyPairCache` comment — where a missing user id fell back to a
// placeholder scope like `?? 0`, silently minting/adopting a keypair under
// the wrong account and permanently desyncing the published key from the
// announce-signing key for every peer.)
//
// getOrCreateIdentityKeyPair's userId argument must come from a value that
// was already checked for `undefined` (the pattern both call sites use), not
// a `??`/`||` fallback that would substitute a placeholder id.
// ─────────────────────────────────────────────────────────────────────────

const noIdentityScopeFallback = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a ??/|| placeholder fallback as the userId argument to getOrCreateIdentityKeyPair. A " +
        "missing user id must abort (see the `userId === undefined` guards at both call sites), never " +
        "substitute a placeholder scope — that mints or adopts a keypair under the wrong account and " +
        "permanently desyncs the published key from the announce-signing key.",
    },
    schema: [],
    messages: {
      placeholderFallback:
        "Do not fall back with ??/|| when passing the user id to getOrCreateIdentityKeyPair — a missing " +
        "id must abort instead (check `=== undefined` and return, as both existing call sites do). A " +
        "placeholder id mints/adopts a keypair under the wrong account and desyncs it from the signing key.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== "Identifier" ||
          node.callee.name !== "getOrCreateIdentityKeyPair"
        ) {
          return;
        }
        const userIdArg = node.arguments[1];
        if (userIdArg === undefined) return;
        if (
          userIdArg.type === "LogicalExpression" &&
          (userIdArg.operator === "??" || userIdArg.operator === "||")
        ) {
          context.report({ node: userIdArg, messageId: "placeholderFallback" });
        }
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Rule: no-store-write-in-ws-on
//
// Invariant (CLAUDE.md): "src/lib/dispatcher.ts is the single WS-event entry
// point: server events reach the stores only through a ws.on(...)
// subscription registered there."
//
// Other modules DO register their own ws.on(...) handlers (page-local UI:
// slow-mode timers, the connected overlay, incoming-call ringing) — that
// itself is not the violation. What must never happen outside dispatcher.ts
// is one of those handlers writing to a domain store directly, bypassing the
// dispatcher. Store *reads* (`fooStore.getState()`) are unaffected; this only
// flags calls to an imported store-mutator function (set/add/update/... from
// a store module) reached from inside a `ws.on(...)` callback.
//
// OC-0478: B9 added three domain stores under `features/*/store.ts`
// (safety, message-requests, moderation) that this rule used to miss — their
// module path is not `stores/`, and several mutators (apply*, note*, begin*,
// fail*, refresh*) were outside the verb list, so a page-local ws.on could
// write them clean. Both are widened here. Store *instances* stay safe: only
// imports whose names match the mutator verbs are recorded, so `safetyStore`
// is never recorded and a `safetyStore.getState()` read is never flagged.
// ─────────────────────────────────────────────────────────────────────────

const STORE_MUTATOR_PREFIX =
  /^(set|add|remove|update|increment|clear|toggle|open|close|join|leave|mark|confirm|bulk|rollback|reset|prepend|reattach|invalidate|load|apply|note|begin|fail|refresh)[A-Z_]/;

function isStoreModuleSource(source, filename) {
  if (typeof source !== "string") return false;
  if (source.startsWith("@stores/")) return true;
  if (!source.startsWith(".")) return false;
  // Resolve a relative specifier against the importing file, so every
  // spelling of the same module ("./store", "../<name>/store",
  // "../../stores/x") lands on one path: the `stores/` layer or a
  // feature-local `src/features/<name>/store.ts`.
  const resolved = path.resolve(path.dirname(filename), source).split(path.sep).join("/");
  return /\/src\/stores\//.test(resolved) || /\/src\/features\/[^/]+\/store$/.test(resolved);
}

// Receivers the WebSocket client is held under: `ws` (main.ts, dispatcher.ts),
// `wsClient`, and a property of either name (`this.ws`, `deps.ws`).
const WS_RECEIVER_NAMES = new Set(["ws", "wsClient"]);

// Subscriptions whose callbacks run on server-driven events, mapped to the
// index of the callback argument. The native certificate listeners
// (`onCertFirstUse`, `onCertMismatch`) are deliberately absent: they carry
// local TLS prompts rather than server frames, and main.ts writes a transient
// error from them on purpose.
const WS_SUBSCRIPTIONS = new Map([
  ["on", 1],
  ["onStateChange", 0],
  ["onSendFailure", 0],
]);

function isWsReceiver(node) {
  if (node.type === "Identifier") return WS_RECEIVER_NAMES.has(node.name);
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    WS_RECEIVER_NAMES.has(node.property.name)
  );
}

/** The callback argument of a `<ws>.on(...)`-style subscription, else null. */
function wsSubscriptionCallback(node) {
  if (node.callee.type !== "MemberExpression" || node.callee.computed) return null;
  if (node.callee.property.type !== "Identifier") return null;
  const index = WS_SUBSCRIPTIONS.get(node.callee.property.name);
  if (index === undefined || !isWsReceiver(node.callee.object)) return null;
  return node.arguments[index] ?? null;
}

/** The function a local binding resolves to: `function f(){}` or
 *  `const f = () => {}`; null for imports and anything else. */
function resolveLocalFunction(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const variable = s.set.get(name);
    if (variable === undefined) continue;
    const def = variable.defs[0];
    if (def?.type === "FunctionName") return def.node;
    if (def?.type === "Variable") return def.node.init;
    return null;
  }
  return null;
}

/** The ReturnStatement arguments of `fn` itself, not of functions nested in it. */
function returnedExpressions(fn, visitorKeys) {
  if (fn.body.type !== "BlockStatement") return [fn.body];
  const found = [];
  const walk = (node) => {
    if (node.type === "ReturnStatement") {
      if (node.argument) found.push(node.argument);
      return;
    }
    if (isFunctionNode(node)) return;
    for (const key of visitorKeys[node.type] ?? []) {
      for (const child of [node[key]].flat()) {
        if (child && typeof child.type === "string") walk(child);
      }
    }
  };
  walk(fn.body);
  return found;
}

/** Every function that `expr` can hand to a subscription as its callback: an
 *  inline function, a local function or const it names, or what a local
 *  factory returns. An imported factory cannot be followed (known limit). */
function handlerFunctions(expr, sourceCode, seen = new Set()) {
  if (!expr || seen.has(expr)) return [];
  seen.add(expr);
  if (isFunctionNode(expr)) return [expr];
  if (expr.type === "Identifier") {
    return handlerFunctions(
      resolveLocalFunction(sourceCode.getScope(expr), expr.name),
      sourceCode,
      seen,
    );
  }
  if (expr.type === "CallExpression" && expr.callee.type === "Identifier") {
    const factory = resolveLocalFunction(sourceCode.getScope(expr), expr.callee.name);
    if (!factory || !isFunctionNode(factory)) return [];
    return returnedExpressions(factory, sourceCode.visitorKeys).flatMap((returned) =>
      handlerFunctions(returned, sourceCode, seen),
    );
  }
  return [];
}

const noStoreWriteInWsOn = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow writing a domain store (an imported set*/add*/update*/... mutator, `<store>.setState(...)`, " +
        "or `<store>.getState().<mutator>(...)`, from a stores/ or features/*/store module) from inside a " +
        "callback registered with ws.on / onStateChange / onSendFailure outside dispatcher.ts, whether the " +
        "callback is inline, a named local function, or returned by a local factory. dispatcher.ts is the " +
        "single place server events are allowed to write into domain stores; a page-local handler may read " +
        "store state and drive its own local UI, but must not mutate a domain store itself.",
    },
    schema: [],
    messages: {
      storeWriteOutsideDispatcher:
        "'{{name}}' writes a domain store from a ws subscription handler outside dispatcher.ts. " +
        "dispatcher.ts is the single WS-event entry point that may write to stores — move this update " +
        "into a dispatcher.ts handler for this message type, or have this handler read the store instead " +
        "of writing it.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const storeMutatorImports = new Set();
    const storeInstanceImports = new Set();
    const handlers = new Set();
    const writes = [];

    /** `<store>.setState` / `<store>.getState().<mutator>`: the written name, else null. */
    function storeInstanceWrite(callee) {
      if (callee.type !== "MemberExpression" || callee.computed) return null;
      if (callee.property.type !== "Identifier") return null;
      const method = callee.property.name;
      const target = callee.object;
      if (method === "setState" && target.type === "Identifier") {
        return storeInstanceImports.has(target.name) ? `${target.name}.setState` : null;
      }
      if (
        STORE_MUTATOR_PREFIX.test(method) &&
        target.type === "CallExpression" &&
        target.callee.type === "MemberExpression" &&
        !target.callee.computed &&
        target.callee.property.type === "Identifier" &&
        target.callee.property.name === "getState" &&
        target.callee.object.type === "Identifier" &&
        storeInstanceImports.has(target.callee.object.name)
      ) {
        return `${target.callee.object.name}.getState().${method}`;
      }
      return null;
    }

    return {
      ImportDeclaration(node) {
        if (!isStoreModuleSource(node.source.value, context.filename)) return;
        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier") continue;
          (STORE_MUTATOR_PREFIX.test(spec.local.name)
            ? storeMutatorImports
            : storeInstanceImports
          ).add(spec.local.name);
        }
      },
      CallExpression(node) {
        const callback = wsSubscriptionCallback(node);
        if (callback !== null) {
          for (const fn of handlerFunctions(callback, sourceCode)) handlers.add(fn);
        }
        const name =
          node.callee.type === "Identifier" && storeMutatorImports.has(node.callee.name)
            ? node.callee.name
            : storeInstanceWrite(node.callee);
        if (name !== null) writes.push({ node, name });
      },
      // A named callback may be declared after the subscription, so decide once
      // every handler is known.
      "Program:exit"() {
        for (const { node, name } of writes) {
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (handlers.has(parent)) {
              context.report({ node, messageId: "storeWriteOutsideDispatcher", data: { name } });
              break;
            }
          }
        }
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Rule: invoke-needs-try-catch
//
// Invariant (CLAUDE.md): "Every Tauri invoke() is wrapped in try/catch where it
// is called, in src/platform/desktop/ ... The catch turns the rejection into a
// typed result or a user-visible error; never let it reach the caller
// unhandled or void it away."
//
// Tauri rejects with the Rust side's raw string, so an invoke that is not
// guarded where it is called hands that string to whoever awaits it. A call is
// guarded when it sits in the `block` of a try statement that has a catch
// clause (and is awaited there: `return invoke(...)` hands the promise out of
// the try), or when its promise chain ends in `.catch(fn)` / `.then(ok, fn)`.
// A call through a wrapper-supplied parameter named `invoke` is the wrapper's
// to guard (externalContent.ts's call()), so it is not reported.
//
// Shipped at `warn`: the audit counted 46 bare sites that predate the rule, and
// they are fixed as their files are touched.
// ─────────────────────────────────────────────────────────────────────────

// socket.ts keeps the resolved command function in `tauriInvoke`.
const INVOKE_NAMES = new Set(["invoke", "tauriInvoke"]);

/** True when the identifier `name` in scope is a function parameter. */
function isInjectedInvoke(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const variable = s.set.get(name);
    if (variable !== undefined) return variable.defs[0]?.type === "Parameter";
  }
  return false;
}

const PROMISE_COMBINATORS = new Set(["all", "allSettled", "race", "any"]);
const TRANSPARENT_WRAPPERS = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);

/** The outermost expression that still carries the `invoke(...)` promise (or a
 *  promise that rejects when it does): through a `.then`/`.finally` hop, a
 *  type-only wrapper, or the array handed to Promise.all/allSettled/race/any.
 *  `await` consumes the promise only when it awaits this node, so
 *  `await [invoke(...)]` (an array resolves at once) does not. */
function promiseCarrier(node) {
  let carrier = node;
  for (;;) {
    const parent = carrier.parent;
    if (TRANSPARENT_WRAPPERS.has(parent.type)) {
      carrier = parent;
    } else if (
      parent.type === "MemberExpression" &&
      parent.object === carrier &&
      !parent.computed &&
      parent.property.type === "Identifier" &&
      (parent.property.name === "then" || parent.property.name === "finally") &&
      parent.parent.type === "CallExpression" &&
      parent.parent.callee === parent
    ) {
      carrier = parent.parent;
    } else if (
      parent.type === "ArrayExpression" &&
      parent.parent.type === "CallExpression" &&
      parent.parent.arguments[0] === parent &&
      parent.parent.callee.type === "MemberExpression" &&
      parent.parent.callee.object.type === "Identifier" &&
      parent.parent.callee.object.name === "Promise" &&
      parent.parent.callee.property.type === "Identifier" &&
      PROMISE_COMBINATORS.has(parent.parent.callee.property.name)
    ) {
      carrier = parent.parent;
    } else {
      return carrier;
    }
  }
}

/** True when `arg` is a callback that can run, not an absent argument or a
 *  literal nothing (`undefined`, `null`, `void 0`). */
function isRejectionHandler(arg) {
  if (arg === undefined) return false;
  if (arg.type === "Literal") return arg.value !== null;
  if (arg.type === "Identifier") return arg.name !== "undefined";
  return !(arg.type === "UnaryExpression" && arg.operator === "void");
}

/** True when the rejection of the `invoke(...)` call `node` is handled in the
 *  function that makes the call. */
function invokeIsGuarded(node) {
  const awaited = promiseCarrier(node).parent.type === "AwaitExpression";
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (isFunctionNode(parent)) return false;
    if (
      parent.type === "MemberExpression" &&
      parent.object === child &&
      !parent.computed &&
      parent.property.type === "Identifier" &&
      parent.parent.type === "CallExpression" &&
      parent.parent.callee === parent
    ) {
      const { name } = parent.property;
      const args = parent.parent.arguments;
      if (name === "catch" && isRejectionHandler(args[0])) return true;
      if (name === "then" && isRejectionHandler(args[1])) return true;
    } else if (parent.type === "TryStatement" && child === parent.block) {
      if (parent.handler !== null) return awaited;
    }
  }
  return false;
}

const invokeNeedsTryCatch = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require a Tauri invoke(...) to sit inside a try block with a catch clause, or to end in " +
        ".catch(fn) / .then(ok, fn). A bare invoke leaks the raw Rust-side rejection string to its " +
        "caller; the catch turns it into a typed result or a user-visible error.",
    },
    schema: [],
    messages: {
      bareInvoke:
        "invoke() must be wrapped in try/catch where it is called (awaited inside the try; `return " +
        "invoke(...)` leaves it), or end in .catch(...). The catch turns the Rust-side rejection " +
        "into a typed result or a user-visible error; do not let it reach the caller unhandled.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || !INVOKE_NAMES.has(node.callee.name)) return;
        if (isInjectedInvoke(context.sourceCode.getScope(node), node.callee.name)) return;
        if (!invokeIsGuarded(node)) context.report({ node, messageId: "bareInvoke" });
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Rule: no-raw-html-sink  (ARCH-038)
//
// Invariant (CLAUDE.md, src/lib/dom.ts): user-controlled text reaches the DOM
// through textContent / @lib/dom helpers, never as parsed HTML. Every raw-HTML
// sink is reported: assigning `innerHTML` / `outerHTML` / `srcdoc`, calling
// `insertAdjacentHTML` / `document.write` / `document.writeln`, and
// `setAttribute("srcdoc", ...)`. `el.innerHTML = ""` is still a sink here;
// use `replaceChildren()`. Only src/lib/icons.ts (static Lucide path data) is
// exempt, via eslint.config.js.
// ─────────────────────────────────────────────────────────────────────────

const HTML_SINK_PROPERTIES = new Set(["innerHTML", "outerHTML", "srcdoc"]);
const HTML_SINK_METHODS = new Set(["insertAdjacentHTML"]);
const DOCUMENT_WRITE_METHODS = new Set(["write", "writeln"]);

/** The value of a string literal or a template literal with no `${}`, else null. */
function staticString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

/** The static name of a member's property (`a.b`, `a["b"]`, ``a[`b`]``), else null. */
function memberName(node) {
  if (node.type !== "MemberExpression") return null;
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : null;
  return staticString(node.property);
}

const noRawHtmlSink = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban raw HTML sinks (innerHTML, outerHTML, srcdoc, insertAdjacentHTML, document.write) so " +
        "user content cannot be parsed as markup. Build DOM nodes with @lib/dom or textContent.",
    },
    schema: [],
    messages: {
      htmlSink:
        "Raw HTML sink '{{name}}' is banned: build nodes with @lib/dom / textContent (use " +
        "replaceChildren() to clear). Only src/lib/icons.ts, which writes static icon paths, is exempt.",
    },
  },
  create(context) {
    const report = (node, name) => context.report({ node, messageId: "htmlSink", data: { name } });
    return {
      AssignmentExpression(node) {
        const name = memberName(node.left);
        if (name !== null && HTML_SINK_PROPERTIES.has(name)) report(node, name);
      },
      CallExpression(node) {
        const name = memberName(node.callee);
        if (name === null) return;
        if (HTML_SINK_METHODS.has(name)) {
          report(node, name);
        } else if (
          DOCUMENT_WRITE_METHODS.has(name) &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "document"
        ) {
          report(node, `document.${name}`);
        } else if (name === "setAttribute") {
          const attr = staticString(node.arguments[0]);
          if (attr !== null && attr.toLowerCase() === "srcdoc") {
            report(node, "setAttribute(srcdoc)");
          }
        }
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Rule: subscription-result-kept  (ARCH-038)
//
// Invariant (CLAUDE.md, lifecycle ownership): `subscribe(...)`,
// `subscribeSelector(...)`, `<ws>.on(...)` and `onAuthCleared(...)` return the
// function that removes the listener. A bare expression statement discards it,
// so the listener can never be removed and leaks past its owner. The result
// must be stored, returned, pushed, or passed on. An app-lifetime listener is
// written `void subscribe(...); // why it lives forever`: the explicit `void`
// is accepted only with a comment on the same line or the line above.
// ─────────────────────────────────────────────────────────────────────────

const SUBSCRIPTION_NAMES = new Set([
  "subscribe",
  "subscribeSelector",
  "onAuthCleared",
  "registerSessionReset",
]);

/** The name reported for a subscription call, else null. */
function subscriptionName(call) {
  const callee = call.callee;
  if (callee.type === "Identifier") {
    return SUBSCRIPTION_NAMES.has(callee.name) ? callee.name : null;
  }
  if (callee.type !== "MemberExpression" || callee.computed) return null;
  if (callee.property.type !== "Identifier") return null;
  const name = callee.property.name;
  if (SUBSCRIPTION_NAMES.has(name)) return name;
  return name === "on" && isWsReceiver(callee.object) ? "ws.on" : null;
}

/** `signal` or `<x>.signal`: an AbortSignal that owns the subscription. */
function isAbortSignalArg(node) {
  if (node.type === "Identifier") return node.name === "signal";
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === "signal"
  );
}

const subscriptionResultKept = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require the unsubscribe function returned by subscribe/subscribeSelector/ws.on/" +
        "onAuthCleared to be stored, returned or passed on, or explicitly `void`-ed with a comment.",
    },
    schema: [],
    messages: {
      discarded:
        "The unsubscribe function returned by {{name}}(...) is discarded. Store it and call it from " +
        "the owner's teardown, or, for an app-lifetime listener, write `void {{name}}(...)` with a " +
        "comment saying why it lives forever.",
      voidNeedsReason:
        "`void {{name}}(...)` must carry a comment (same line or the line above) saying why the " +
        "listener lives for the app's lifetime.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      ExpressionStatement(node) {
        let expr = node.expression;
        let isVoid = false;
        if (expr.type === "UnaryExpression" && expr.operator === "void") {
          isVoid = true;
          expr = expr.argument;
        }
        // `await x.subscribe(fn)` and `x?.subscribe(fn)` discard it just the same.
        if (expr.type === "AwaitExpression") expr = expr.argument;
        if (expr.type === "ChainExpression") expr = expr.expression;
        if (expr.type !== "CallExpression") return;
        const name = subscriptionName(expr);
        if (name === null) return;
        if (!isVoid) {
          // `store.subscribe(fn, signal)` is owned by the AbortSignal.
          if (expr.arguments.some(isAbortSignalArg)) return;
          context.report({ node, messageId: "discarded", data: { name } });
          return;
        }
        const line = node.loc.start.line;
        const commented = sourceCode
          .getAllComments()
          .some(
            (c) =>
              c.loc.end.line === line - 1 ||
              c.loc.start.line === line ||
              c.loc.end.line === node.loc.end.line,
          );
        if (!commented) context.report({ node, messageId: "voidNeedsReason", data: { name } });
      },
    };
  },
};

// --- layer-direction -------------------------------------------------------
// A lower layer never imports a higher one. The rank is the first path segment
// under Client/src/; an importer of rank R may import targets of rank <= R, and
// peers (same rank) may import each other.
//
//   6  main.ts, app/
//   5  pages/
//   4  components/, features/        (peers)
//   3  stores/
//   2  lib/, platform/, i18n/        (peers)
//   1  styles/, assets/
//
// Counted: static `import`, `export ... from` (including `export *`), a
// side-effect import and a dynamic `import("literal")`: each is a runtime edge.
// Not counted: `import type`, `export type`, a list whose every specifier is
// `type`, and `typeof import("x")` in a type position (emit drops all of them).
// A plain `import { X }` used only as a type is a value import to the parser,
// so it counts; write `import type`. Colocated `*.test.ts(x)` files are exempt.
//
// The rule is string and path based. An alias (`@lib`, `@stores`,
// `@components`, `@pages`, `@styles`, as in tsconfig.json) and a relative
// specifier that name the same module get the same verdict and the same
// baseline key: the resolved file relative to src/ (a directory import
// resolves to its index.ts). The filesystem is read only for a site that is
// upward, to find that file.
//
// Option `baseline` is Client/scripts/layer-baseline.json:
// `{ sanctioned, debt }`, each `{ "<importer>": { "<target>": <site count> } }`.
// A site is reported only when its importer has more sites to that target than
// the baseline lists, so a second upward import of a listed target is an
// error. tests/unit/layer-baseline.test.ts keeps the baseline shrink-only.
const SRC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "src");

/** Layer rank by first path segment under src/ (`main` is `main.ts`). */
const LAYER_RANK = new Map([
  ["main", 6],
  ["app", 6],
  ["pages", 5],
  ["components", 4],
  ["features", 4],
  ["stores", 3],
  ["lib", 2],
  ["platform", 2],
  ["i18n", 2],
  ["styles", 1],
  ["assets", 1],
]);

/** The five tsconfig `paths` aliases, as alias -> directory under src/. */
const LAYER_ALIASES = new Map([
  ["@lib", "lib"],
  ["@stores", "stores"],
  ["@components", "components"],
  ["@pages", "pages"],
  ["@styles", "styles"],
]);

const TEST_FILE = /\.test\.tsx?$/;
const MAIN_MODULE = /^main(\.[jt]sx?)?$/;

/** Layer name of a posix path relative to src/, or null when it has none. */
function layerOfRel(rel) {
  const parts = rel.split("/");
  if (parts.length === 1) {
    // `main.ts`, or `main` as an extensionless import specifier; a bare layer
    // name is a directory import (it resolves to that layer's index).
    if (MAIN_MODULE.test(parts[0])) return "main";
    return LAYER_RANK.has(parts[0]) ? parts[0] : null;
  }
  return LAYER_RANK.has(parts[0]) ? parts[0] : null;
}

/** `file` as a posix path relative to src/, or null when it is outside src/. */
function relToSrc(file) {
  const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? null : rel;
}

const resolvedTargets = new Map();

/** The file a specifier base names, relative to src/: the extensionless or
 *  `.js` form resolves to `.ts`/`.tsx`, a directory to its index. Falls back
 *  to `<base>.ts` when nothing exists on disk (fixtures). */
function resolveTargetFile(relBase) {
  const cached = resolvedTargets.get(relBase);
  if (cached !== undefined) return cached;
  const candidates = [
    relBase,
    `${relBase}.ts`,
    `${relBase}.tsx`,
    `${relBase}/index.ts`,
    `${relBase}/index.tsx`,
    relBase.replace(/\.js$/, ".ts"),
  ];
  let found = `${relBase}.ts`;
  for (const candidate of candidates) {
    try {
      if (statSync(path.join(SRC_ROOT, candidate)).isFile()) {
        found = candidate;
        break;
      }
    } catch {
      // not a file; try the next form
    }
  }
  resolvedTargets.set(relBase, found);
  return found;
}

/** The target of `spec` as a posix path relative to src/ (extension and index
 *  not yet resolved), or null for a bare package or a path outside src/. */
function targetBase(rawSpec, importerRel) {
  // A Vite suffix (`?raw`, `?url`, `#hash`) is not part of the module path.
  const spec = rawSpec.replace(/[?#].*$/, "");
  if (spec.startsWith(".")) {
    return relToSrc(path.join(SRC_ROOT, path.posix.dirname(importerRel), spec));
  }
  for (const [alias, dir] of LAYER_ALIASES) {
    if (spec.startsWith(`${alias}/`)) {
      // Normalise so `@lib/../pages/x` is judged by where it lands.
      const base = path.posix.normalize(`${dir}/${spec.slice(alias.length + 1)}`);
      return base.startsWith("..") ? null : base.replace(/\/$/, "");
    }
  }
  return null;
}

function baselineCount(baseline, importer, target) {
  let total = 0;
  for (const section of [baseline.sanctioned, baseline.debt]) {
    const n = section?.[importer]?.[target];
    if (typeof n === "number") total += n;
  }
  return total;
}

function allSpecifiersTypeOnly(specifiers, kindKey) {
  return specifiers.length > 0 && specifiers.every((s) => s[kindKey] === "type");
}

const layerDirection = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A lower layer must not import a higher one (main/app > pages > components/features > stores > lib/platform/i18n > styles/assets). Existing upward imports are listed in scripts/layer-baseline.json and only shrink.",
    },
    schema: [
      {
        type: "object",
        properties: { baseline: { type: "object" } },
        additionalProperties: false,
      },
    ],
    messages: {
      upwardImport:
        "{{importer}} -> {{target}}: {{fromLayer}}/ must not import {{toLayer}}/ (layers import downward or sideways only). Move the shared piece down, or invert the dependency. Listed edges live in scripts/layer-baseline.json and only shrink.",
    },
  },
  create(context) {
    const baseline = context.options[0]?.baseline ?? {};
    const filename = path.isAbsolute(context.filename)
      ? context.filename
      : path.resolve(path.dirname(SRC_ROOT), context.filename);
    const importerRel = relToSrc(filename);
    if (importerRel === null || TEST_FILE.test(importerRel)) return {};
    const fromLayer = layerOfRel(importerRel);
    if (fromLayer === null) return {};
    const fromRank = LAYER_RANK.get(fromLayer);

    /** Upward sites in source order, grouped by resolved target file. */
    const sites = new Map();
    const check = (node, source) => {
      if (typeof source !== "string") return;
      const base = targetBase(source, importerRel);
      if (base === null) return;
      const toLayer = layerOfRel(base);
      if (toLayer === null || LAYER_RANK.get(toLayer) <= fromRank) return;
      const target = resolveTargetFile(base);
      const list = sites.get(target) ?? [];
      list.push({ node, toLayer });
      sites.set(target, list);
    };

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type" || allSpecifiersTypeOnly(node.specifiers, "importKind")) {
          return;
        }
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source === null || node.source === undefined) return;
        if (node.exportKind === "type" || allSpecifiersTypeOnly(node.specifiers, "exportKind")) {
          return;
        }
        check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === "type") return;
        check(node, node.source.value);
      },
      ImportExpression(node) {
        const { source } = node;
        if (source.type === "Literal") check(node, source.value);
        else if (source.type === "TemplateLiteral" && source.expressions.length === 0) {
          check(node, source.quasis[0].value.cooked);
        }
      },
      "Program:exit"() {
        for (const [target, list] of sites) {
          const allowed = baselineCount(baseline, importerRel, target);
          for (const site of list.slice(allowed)) {
            context.report({
              node: site.node,
              messageId: "upwardImport",
              data: { importer: importerRel, target, fromLayer, toLayer: site.toLayer },
            });
          }
        }
      },
    };
  },
};

// Exported so tests/unit/layer-baseline.test.ts can pin the maps to the real tree.
export { LAYER_ALIASES, LAYER_RANK };

export default {
  rules: {
    "no-leave-voice-when-superseded": noLeaveVoiceWhenSuperseded,
    "e2ee-epoch-needs-keypair-check": e2eeEpochNeedsKeypairCheck,
    "e2ee-verified-status-literal": e2eeVerifiedStatusLiteral,
    "no-identity-scope-fallback": noIdentityScopeFallback,
    "no-store-write-in-ws-on": noStoreWriteInWsOn,
    "invoke-needs-try-catch": invokeNeedsTryCatch,
    "no-raw-html-sink": noRawHtmlSink,
    "subscription-result-kept": subscriptionResultKept,
    "layer-direction": layerDirection,
  },
};
