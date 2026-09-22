// B7-11a: the ownership inventory (R1-R4).
//
// A grep counts `addEventListener` calls; it cannot tell an owned listener from
// a leak. The three fixed findings that motivated this milestone (OC-0335,
// OC-0336, OC-0365) each passed a "does it pass a signal" check while being
// registered on a signal that lived longer than the thing it served. So this
// test classifies every site from the syntax tree and fails on a site that is
// not owned and not on an exact allowlist.
//
// The allowlists are exact and shrink-only: an allowlisted site that no longer
// exists fails with "remove this entry", the same ratchet as the cycle ceiling.
// Entries are keyed by file + receiver + event (R1) or file + enclosing
// function (R3, R4), never by line number, so an unrelated edit does not churn
// them. `b7-11-lifecycle-ownership-long-session.plan.md` owns the category of
// each entry; 11b empties the component/per-render entries, 11c the findings.
//
// The runtime soak (tests/e2e/support/lifecycle-probe.ts) is the proof this
// lexical inventory is only the ratchet for.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const clientRoot = path.resolve(__dirname, "../..");
const srcDir = path.join(clientRoot, "src");

// R1's long-lived targets, matched by name. A MediaQueryList or a store-held
// target is out of scope; the soak's listener counter is what would see one.
const LONG_LIVED = /^(window|document|document\.body|document\.documentElement|navigator\..*)$/;

// The two lifecycle primitives. R4 exempts them by rule, not by allowlist.
const PRIMITIVE_FILES = new Set(["lib/disposable.ts", "lib/sessionScope.ts"]);

const sourceFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter(
    (entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts"),
  )
  .map((entry) => entry.split(path.sep).join("/"))
  .toSorted();

interface R1Entry {
  file: string;
  receiver: string;
  event: string;
  category: "app-lifetime" | "per-mount";
  reason: string;
}
interface R3Entry {
  file: string;
  fn: string;
  reason: string;
}
interface R4Entry {
  file: string;
  fn: string;
  category: "component-lifetime" | "per-render-child" | "cancellation-token";
  reason: string;
}

// R1: long-lived-target listeners without `signal`/`once: true`.
const R1_ALLOWLIST: readonly R1Entry[] = [
  {
    file: "components/message-list/attachments.ts",
    receiver: "window",
    event: "owncord:pref-change",
    category: "app-lifetime",
    reason: "app-lifetime preference listener installed once at module load",
  },
  {
    file: "components/message-list/formatting.ts",
    receiver: "window",
    event: "owncord:pref-change",
    category: "app-lifetime",
    reason: "app-lifetime preference listener installed once at module load",
  },
  {
    file: "components/message-list/media.ts",
    receiver: "window",
    event: "owncord:pref-change",
    category: "app-lifetime",
    reason: "app-lifetime preference listener installed once at module load",
  },
  {
    file: "components/message-list/renderers.ts",
    receiver: "window",
    event: "owncord:pref-change",
    category: "app-lifetime",
    reason: "app-lifetime preference listener installed once at module load",
  },
  {
    file: "lib/channel-mutes.ts",
    receiver: "window",
    event: "owncord:pref-change",
    category: "app-lifetime",
    reason: "app-lifetime preference listener installed once at module load",
  },
  {
    file: "lib/channel-mutes.ts",
    receiver: "window",
    event: "storage",
    category: "app-lifetime",
    reason: "app-lifetime cross-tab storage listener installed once at module load",
  },
  {
    file: "lib/deviceManager.ts",
    receiver: "navigator.mediaDevices",
    event: "devicechange",
    category: "per-mount",
    reason:
      "device-change listener with a start/stop pair (startDeviceChangeListener); stays hand-paired because device-manager.test.ts pins the bare add/remove call shape, and 11b edits no assertion",
  },
  {
    file: "lib/logger.ts",
    receiver: "window",
    event: "owncord:pref-change",
    category: "app-lifetime",
    reason: "app-lifetime preference listener installed once at module load",
  },
  {
    file: "lib/media-visibility.ts",
    receiver: "document",
    event: "visibilitychange",
    category: "app-lifetime",
    reason: "once-guarded app-lifetime visibility listener (ensureVisibilityListener)",
  },
  {
    file: "lib/media-visibility.ts",
    receiver: "window",
    event: "blur",
    category: "app-lifetime",
    reason: "once-guarded app-lifetime visibility listener (ensureVisibilityListener)",
  },
  {
    file: "lib/media-visibility.ts",
    receiver: "window",
    event: "focus",
    category: "app-lifetime",
    reason: "once-guarded app-lifetime visibility listener (ensureVisibilityListener)",
  },
  {
    file: "lib/safe-render.ts",
    receiver: "window",
    event: "error",
    category: "app-lifetime",
    reason: "global error handler installed once at startup (installGlobalErrorHandlers)",
  },
  {
    file: "lib/safe-render.ts",
    receiver: "window",
    event: "unhandledrejection",
    category: "app-lifetime",
    reason: "global rejection handler installed once at startup (installGlobalErrorHandlers)",
  },
  {
    file: "main.ts",
    receiver: "document",
    event: "contextmenu",
    category: "app-lifetime",
    reason: "app-bootstrap singleton at module load",
  },
  {
    file: "main.ts",
    receiver: "document",
    event: "keydown",
    category: "app-lifetime",
    reason: "app-bootstrap singleton at module load",
  },
  {
    file: "main.ts",
    receiver: "document",
    event: "click",
    category: "app-lifetime",
    reason: "app-bootstrap singleton at module load",
  },
  {
    file: "main.ts",
    receiver: "window",
    event: "beforeunload",
    category: "app-lifetime",
    reason: "app-bootstrap best-effort voice_leave at module load",
  },
];
// R3: discarded `setTimeout` handles (expression statement or `void`).
const R3_ALLOWLIST: readonly R3Entry[] = [
  {
    file: "components/Toast.ts",
    fn: "removeToast",
    reason: "self-bounded: fallback removal after transitionend; touches only the node it removes",
  },
  {
    file: "components/message-list/content-parser.ts",
    fn: "renderCodeBlock",
    reason:
      "self-bounded: copy-button label reset on a node the code block owns; renderMessageContent takes no owner to clear it from",
  },
  {
    file: "components/message-list/content-parser.ts",
    fn: "renderCodeBlock",
    reason:
      "self-bounded: copy-button label reset on a node the code block owns; renderMessageContent takes no owner to clear it from",
  },
];
// R4: every `new AbortController` outside the two primitives.
const R4_ALLOWLIST: readonly R4Entry[] = [
  {
    file: "components/AdminActions.ts",
    fn: "createMemberContextMenu",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/AdminActions.ts",
    fn: "createChannelContextMenu",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/CertMismatchModal.ts",
    fn: "createCertMismatchModal",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/CertMismatchModal.ts",
    fn: "createCertFirstUseModal",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/CertMismatchModal.ts",
    fn: "createIdentityMismatchModal",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/ChannelSidebar.ts",
    fn: "createChannelSidebar",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/ChannelSidebar.ts",
    fn: "renderChannels",
    category: "per-render-child",
    reason:
      "per-render child signal, aborted and replaced on the next render; 11b moves it onto a child Disposable",
  },
  {
    file: "components/ConnectedOverlay.ts",
    fn: "createConnectedOverlay",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/CreateChannelModal.ts",
    fn: "createCreateChannelModal",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/DeleteChannelModal.ts",
    fn: "createDeleteChannelModal",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/DmProfileSidebar.ts",
    fn: "createDmProfileSidebar",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/DmSidebar.ts",
    fn: "createDmSidebar",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/EditChannelModal.ts",
    fn: "createEditChannelModal",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/EmojiPicker.ts",
    fn: "createEmojiPicker",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/GifPicker.ts",
    fn: "createGifPicker",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/IncomingCallBanner.ts",
    fn: "createIncomingCallBanner",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/InviteManager.ts",
    fn: "createInviteManager",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/MemberList.ts",
    fn: "render",
    category: "per-render-child",
    reason:
      "per-render child signal, aborted and replaced on the next render; 11b moves it onto a child Disposable",
  },
  {
    file: "components/MessageInput.ts",
    fn: "createMessageInput",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/MessageList.ts",
    fn: "createMessageList",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/MessageList.ts",
    fn: "beginRowRender",
    category: "per-render-child",
    reason:
      "per-render child signal, aborted and replaced on the next render; 11b moves it onto a child Disposable",
  },
  {
    file: "components/NsfwGate.ts",
    fn: "createNsfwGate",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/PinnedMessages.ts",
    fn: "createPinnedMessages",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/QuickSwitchOverlay.ts",
    fn: "createQuickSwitchOverlay",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/QuickSwitcher.ts",
    fn: "createQuickSwitcher",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/SearchOverlay.ts",
    fn: "createSearchOverlay",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/SearchOverlay.ts",
    fn: "doSearch",
    category: "cancellation-token",
    reason: "owner: the next search, which aborts this one",
  },
  {
    file: "components/SettingsOverlay.ts",
    fn: "createSettingsOverlay",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/SettingsOverlay.ts",
    fn: "renderActiveTab",
    category: "per-render-child",
    reason:
      "per-render child signal, aborted and replaced on the next render; 11b moves it onto a child Disposable",
  },
  {
    file: "components/StatusPicker.ts",
    fn: "createStatusPicker",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/UserProfilePopup.ts",
    fn: "createUserProfilePopup",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/VoiceWidget.ts",
    fn: "createVoiceWidget",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/channel-sidebar/context-menu.ts",
    fn: "attachChannelContextMenu",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/channel-sidebar/drag-reorder.ts",
    fn: "ensureGlobalDragListeners",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/channel-sidebar/volume-menu.ts",
    fn: "showUserVolumeMenu",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/inline-autocomplete.ts",
    fn: "createInlineAutocomplete",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/message-list/attachments.ts",
    fn: "openImageLightbox",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "components/settings/ConnectionDiagnosticsPanel.ts",
    fn: "createConnectionDiagnosticsPanel",
    category: "cancellation-token",
    reason: "owner: stop() and the next test run, which abort this attempt",
  },
  {
    file: "lib/api.ts",
    fn: "doFetch",
    category: "cancellation-token",
    reason: "owner: the SessionScope that aborts the transport (api.ts owner.addCleanup)",
  },
  {
    file: "lib/api.ts",
    fn: "getHealth",
    category: "cancellation-token",
    reason: "owner: the SessionScope that aborts the transport (api.ts owner.addCleanup)",
  },
  {
    file: "lib/api.ts",
    fn: "getServerInfo",
    category: "cancellation-token",
    reason: "owner: the SessionScope that aborts the transport (api.ts owner.addCleanup)",
  },
  {
    file: "lib/autoIdle.ts",
    fn: "startAutoIdle",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "lib/context-menu.ts",
    fn: "showContextMenu",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "lib/modalFactory.ts",
    fn: "createModal",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "lib/os-motion.ts",
    fn: "syncOsMotionListener",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "lib/profiles.ts",
    fn: "pingHost",
    category: "cancellation-token",
    reason: "owner: the per-attempt HEALTH_TIMEOUT_MS timer that aborts it",
  },
  {
    file: "lib/roomEventHandlers.ts",
    fn: "handleDisconnected",
    category: "cancellation-token",
    reason: "owner: the next attempt, which aborts this one",
  },
  {
    file: "pages/ConnectPage.ts",
    fn: "createConnectPage",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "pages/MainPage.ts",
    fn: "mount",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "pages/connect-page/ServerPanel.ts",
    fn: "renderServerProfiles",
    category: "per-render-child",
    reason:
      "per-render child signal, aborted and replaced on the next render; 11b moves it onto a child Disposable",
  },
  {
    file: "pages/connect-page/ServerPanel.ts",
    fn: "handleAddServer",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
  {
    file: "pages/main-page/ChannelController.ts",
    fn: "mountChannel",
    category: "cancellation-token",
    reason: "owner: the next channel switch, which aborts the previous channel's work",
  },
  {
    file: "pages/main-page/SidebarMemberSection.ts",
    fn: "createSidebarMemberSection",
    category: "component-lifetime",
    reason: "component/overlay factory lifetime; 11b moves it onto a Disposable",
  },
];

/** A found site: its allowlist key and a readable `file:line` descriptor. */
type Site = readonly [key: string, where: string];

/** The name of the nearest enclosing function or arrow assigned to a binding. */
function enclosingFunction(sf: ts.SourceFile, node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.getText(sf);
    if (
      ts.isVariableDeclaration(current) &&
      current.name &&
      current.initializer &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    )
      return current.name.getText(sf);
    if (
      ts.isPropertyAssignment(current) &&
      current.name &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    )
      return current.name.getText(sf);
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText(sf);
    current = current.parent;
  }
  return "<top>";
}

function calleeName(node: ts.CallExpression): string {
  const c = node.expression;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  if (ts.isIdentifier(c)) return c.text;
  return "";
}

const r1Found: Site[] = [];
const r2Found: Site[] = [];
const r3Found: Site[] = [];
const r4Found: Site[] = [];
let bareListeners = 0;
const bareListenerFiles = new Set<string>();
let rafCount = 0;
let cancelRafCount = 0;
const observerFiles = new Set<string>();
const nativeListen: string[] = [];

for (const rel of sourceFiles) {
  const sf = ts.createSourceFile(
    rel,
    readFileSync(path.join(srcDir, rel), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const fileText = sf.getFullText();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === "addEventListener") {
        const opts = node.arguments[2] ? node.arguments[2].getText(sf) : "";
        if (!/\bsignal\b/.test(opts) && !/\bonce\s*:\s*true/.test(opts)) {
          bareListeners++;
          bareListenerFiles.add(rel);
          const target = ts.isPropertyAccessExpression(node.expression)
            ? node.expression.expression.getText(sf)
            : "";
          if (LONG_LIVED.test(target)) {
            const eventArg = node.arguments[0]!;
            const event = ts.isStringLiteralLike(eventArg) ? eventArg.text : eventArg.getText(sf);
            r1Found.push([
              `${rel}|${target}|${event}`,
              `${rel}:${line(node)} ${target} "${event}"`,
            ]);
          }
        }
      }
      if (name === "setTimeout" || name === "setInterval") {
        const discarded = ts.isExpressionStatement(node.parent) || ts.isVoidExpression(node.parent);
        if (name === "setInterval") {
          if (discarded || !fileText.includes("clearInterval("))
            r2Found.push([
              `${rel}|${enclosingFunction(sf, node)}`,
              `${rel}:${line(node)} setInterval ${discarded ? "discarded" : "no clearInterval in file"}`,
            ]);
        } else if (discarded) {
          r3Found.push([
            `${rel}|${enclosingFunction(sf, node)}`,
            `${rel}:${line(node)} discarded setTimeout in ${enclosingFunction(sf, node)}`,
          ]);
        }
      }
      if (name === "requestAnimationFrame") rafCount++;
      if (name === "cancelAnimationFrame") cancelRafCount++;
      if (name === "listen" && rel.startsWith("platform/"))
        nativeListen.push(`${rel}:${line(node)}`);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "AbortController" &&
      !PRIMITIVE_FILES.has(rel)
    ) {
      const fn = enclosingFunction(sf, node);
      r4Found.push([`${rel}|${fn}`, `${rel}:${line(node)} new AbortController() in ${fn}`]);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["IntersectionObserver", "ResizeObserver", "MutationObserver"].includes(node.expression.text)
    ) {
      observerFiles.add(rel);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * Multiset compare: every found site must be covered by an entry, and every
 * entry must be used by a site. A duplicate site needs a duplicate entry, so
 * the lists cannot silently under- or over-count.
 */
function compare(label: string, found: readonly Site[], allowed: readonly string[]): void {
  const remaining = new Map<string, number>();
  for (const key of allowed) remaining.set(key, (remaining.get(key) ?? 0) + 1);

  const unowned: string[] = [];
  for (const [key, where] of found) {
    const left = remaining.get(key) ?? 0;
    if (left === 0) unowned.push(where);
    else remaining.set(key, left - 1);
  }
  expect(unowned, `${label}: add these sites to the allowlist or own them`).toEqual([]);

  const stale = [...remaining]
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key} (${count} unused)`);
  expect(stale, `${label}: remove these allowlist entries — the sites are gone`).toEqual([]);
}

const keys = (entries: readonly { file: string; fn: string }[]) =>
  entries.map((e) => `${e.file}|${e.fn}`);

describe("lifecycle ownership inventory (R1-R4)", () => {
  it("scans the tree it claims to scan", () => {
    expect(sourceFiles.length).toBeGreaterThan(200);
    expect(sourceFiles).toContain("main.ts");
  });

  it("R1: every long-lived-target listener carries a signal or once, or is allowlisted", () => {
    compare(
      "R1",
      r1Found,
      R1_ALLOWLIST.map((e) => `${e.file}|${e.receiver}|${e.event}`),
    );
  });

  it("R2: every setInterval keeps its handle and is cleared in its own file", () => {
    compare("R2", r2Found, []);
  });

  it("R3: every setTimeout handle is kept, or the site is allowlisted", () => {
    compare("R3", r3Found, keys(R3_ALLOWLIST));
  });

  it("R4: every AbortController is a primitive or allowlisted", () => {
    compare("R4", r4Found, keys(R4_ALLOWLIST));
  });

  it("the allowlist categories are at their 11b floors (16 app-lifetime, 1 per-mount)", () => {
    expect(R1_ALLOWLIST.filter((e) => e.category === "app-lifetime")).toHaveLength(16);
    expect(R1_ALLOWLIST.filter((e) => e.category === "per-mount")).toHaveLength(1);
    expect(R4_ALLOWLIST.filter((e) => e.category === "cancellation-token")).toHaveLength(8);
  });

  it("prints the informational counts", () => {
    const report = {
      bareListeners,
      bareListenerFiles: bareListenerFiles.size,
      rafCount,
      cancelRafCount,
      observerFiles: [...observerFiles].toSorted(),
      nativeListen,
    };
    // console.log is not guarded (only warn/error are); this is a record, not a
    // failure signal.
    console.log("lifecycle inventory counts:", JSON.stringify(report));
    expect(report.bareListeners).toBeGreaterThan(0);
  });
});
