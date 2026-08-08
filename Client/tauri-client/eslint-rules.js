// Custom ESLint rules that turn three of the invariants documented in prose in
// CLAUDE.md into enforced, test-covered lint rules. Each rule is scoped (via
// `files:` in eslint.config.js) to only the module(s) its invariant governs —
// see the per-rule `meta.docs.description` for the invariant it encodes and
// tests/unit/eslint-rules.test.ts for the real-code shapes it was proven
// against (both the shapes that must stay clean and the historical bug shapes
// it must catch).
//
// Plain JS, ESM, no build step — eslint.config.js imports this directly.

/** True when `node` is a `this.<methodName>(...)` call. */
function isThisMethodCall(node, methodName) {
  return (
    node !== null &&
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "ThisExpression" &&
    !node.callee.computed &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === methodName
  );
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
  if (isThisMethodCall(test, "reconnectSuperseded")) return true;
  if (test.type === "UnaryExpression" && test.operator === "!") {
    return isThisMethodCall(test.argument, "isStateConnected");
  }
  return false;
}

const noLeaveVoiceWhenSuperseded = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow this.leaveVoice() inside a branch that already confirmed this connect/reconnect " +
        "attempt was superseded. Voice sessions are superseded, not cancelled — once reconnectSuperseded() " +
        "or !isStateConnected() is true, `_state` may already belong to a newer, live attempt, and " +
        "leaveVoice() there tears that live session down instead of the aborted one.",
    },
    schema: [],
    messages: {
      unsafeLeaveVoice:
        "this.leaveVoice() must not run once this attempt is known to be superseded — it acts on " +
        "whichever session currently owns `_state`, which may now be a newer, live attempt. Disconnect " +
        "only this attempt's own room instead (e.g. disconnectSupersededLocalRoom(localRoom) / " +
        "localRoom.disconnect()), or simply return without calling it.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isThisMethodCall(node, "leaveVoice")) return;
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
        "The `status` passed here must be a string literal ('verified' | 'unverified' | 'mismatch' | " +
        "'unknown'), not a computed expression. Add a new literal call site for this outcome instead of " +
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
// a `*/stores/*` module) reached from inside a `ws.on(...)` callback.
// ─────────────────────────────────────────────────────────────────────────

const STORE_MUTATOR_PREFIX =
  /^(set|add|remove|update|increment|clear|toggle|open|close|join|leave|mark|confirm|bulk|rollback|reset|prepend|reattach|invalidate|load)[A-Z_]/;

function isStoreModuleSource(source) {
  // Matches both the "@stores/..." alias and relative "../stores/..." paths.
  return typeof source === "string" && /(?:^|\/)@?stores\//.test(source);
}

function isWsOnCall(node) {
  return (
    node !== null &&
    node !== undefined &&
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "ws" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "on" &&
    node.arguments.length >= 2
  );
}

const noStoreWriteInWsOn = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow calling an imported store-mutator (set*/add*/update*/... from a stores/ module) from " +
        "inside a ws.on(...) callback outside dispatcher.ts. dispatcher.ts is the single place server " +
        "events are allowed to write into domain stores; a page-local ws.on(...) handler may read store " +
        "state and drive its own local UI, but must not mutate a domain store itself.",
    },
    schema: [],
    messages: {
      storeWriteOutsideDispatcher:
        "'{{name}}' is a store mutator called from a ws.on(...) handler outside dispatcher.ts. " +
        "dispatcher.ts is the single WS-event entry point that may write to stores — move this update " +
        "into a dispatcher.ts handler for this message type, or have this handler read the store instead " +
        "of writing it.",
    },
  },
  create(context) {
    const storeMutatorImports = new Set();

    return {
      ImportDeclaration(node) {
        if (!isStoreModuleSource(node.source.value)) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier" && STORE_MUTATOR_PREFIX.test(spec.local.name)) {
            storeMutatorImports.add(spec.local.name);
          }
        }
      },
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || !storeMutatorImports.has(node.callee.name)) return;
        let parent = node.parent;
        while (parent) {
          if (
            isFunctionNode(parent) &&
            isWsOnCall(parent.parent) &&
            parent.parent.arguments[1] === parent
          ) {
            context.report({
              node,
              messageId: "storeWriteOutsideDispatcher",
              data: { name: node.callee.name },
            });
            return;
          }
          parent = parent.parent;
        }
      },
    };
  },
};

export default {
  rules: {
    "no-leave-voice-when-superseded": noLeaveVoiceWhenSuperseded,
    "e2ee-epoch-needs-keypair-check": e2eeEpochNeedsKeypairCheck,
    "e2ee-verified-status-literal": e2eeVerifiedStatusLiteral,
    "no-identity-scope-fallback": noIdentityScopeFallback,
    "no-store-write-in-ws-on": noStoreWriteInWsOn,
  },
};
