#!/usr/bin/env node
// UI string inventory and shrink-only gate (B9-3, BPR-064).
//
// From Client/:
//   node scripts/check-ui-strings.mjs            # fail on new or stale entries
//   node scripts/check-ui-strings.mjs --update   # shrink the baseline after extraction
//   node scripts/check-ui-strings.mjs --report   # per-file owner/category table (markdown)
//
// What it finds: it parses every src/**/*.ts file with the TypeScript compiler
// and reports string and template literals that are UI text by position (the
// argument of setText/showToast, a textContent/title/placeholder assignment, an
// aria-label/title/alt attribute, a label/desc property) or by shape (prose:
// words with spaces, a capitalised word, sentence punctuation). Templates are
// reported with each substitution shown as {…}.
//
// What it cannot find, stated so nobody reads a green run as "no English left":
// text assembled from non-literal pieces, a single lowercase word outside a
// known sink (a placeholder of "general"), text built in a helper and passed
// through a variable to a sink, and text in CSS `content:` or HTML files. Its
// shape rule also flags some non-UI prose (thrown internal errors); those are
// listed with their owner and either extracted or exempted with a reason.
//
// Exempt a literal that is intentionally not app copy (a wire identifier, a
// user-data default, an internal error that never reaches the UI) with a
// comment carrying a reason on the same line or on a comment-only line above:
//   // i18n-exempt: protocol error code, mapped to catalog text by the caller
//
// The baseline (scripts/ui-strings-baseline.json) is the migration inventory:
// per file, its owning milestone and each unextracted literal with its count.
// It may only shrink. A literal whose count exceeds its baseline is new UI text
// and fails; move it to a catalog under src/i18n/ or exempt it. A baseline
// entry the source no longer has also fails until `--update` removes it, so
// the baseline never keeps credit for text that is gone. Entries are keyed by
// text, not line, so unrelated edits above a literal do not churn the file.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const CLIENT = join(import.meta.dirname, "..");
const SRC = join(CLIENT, "src");
export const BASELINE_PATH = join(CLIENT, "scripts", "ui-strings-baseline.json");

/** Files that hold no app copy to extract, each with its reason. */
const EXCLUDED = [
  [/^src\/i18n\//, "the English catalogs themselves: the sanctioned home of app copy"],
  [/\.test\.ts$/, "unit tests: fixtures and assertions, never rendered"],
  [/\.d\.ts$/, "type declarations: no runtime text"],
  [/^src\/lib\/protocolTypes\.ts$/, "generated from protocol/schema.json: wire identifiers"],
  [/^src\/lib\/icons\.ts$/, "SVG path markup, no text"],
  [
    /^src\/components\/message-list\/syntax-highlight\.ts$/,
    "programming-language keyword tables for code highlighting, never copy",
  ],
];

/**
 * Owning extraction milestone per file, first match wins. Taken from the
 * file tables of the B9-18/19/20 plans; the last rule is B9-20's closing sweep
 * ("merge the final inventory of every Client/src text sink").
 */
const OWNERS = [
  [
    /^src\/(pages\/ConnectPage|pages\/connect-page\/|pages\/main-page\/Sidebar|pages\/main-page\/OverlayManagers|components\/(QuickSwitchOverlay|QuickSwitcher|CertMismatchModal|ServerBanner|ConnectedOverlay|UserBar|StatusPicker|MemberList|AdminActions|InviteManager|ChannelSidebar|CreateChannelModal|EditChannelModal|DeleteChannelModal|purge-prompt)\.ts|components\/channel-sidebar\/context-menu\.ts|lib\/(streamPreview|safe-render|credentials)\.ts|features\/channels\/wsHandlers\.ts|main\.ts)/,
    "B9-18",
  ],
  [
    /^src\/(components\/message-list\/|components\/(MessageList|MessageInput|GifPicker|SearchOverlay|PinnedMessages|DmSidebar|DmProfileSidebar|EmojiPicker|UserProfilePopup|NsfwGate|MentionAutocomplete|EmojiAutocomplete)\.ts|pages\/main-page\/(ChannelController|MessageJump|ChatHeader|MemberPickerModal)\.ts)/,
    "B9-19",
  ],
  [/^src\//, "B9-20"],
];

/** Calls whose literal arguments are developer diagnostics, never UI. */
const LOG_METHODS = new Set(["trace", "debug", "info", "warn", "error", "log"]);
/** Calls whose literal arguments are selectors, keys, event or command names. */
const NON_TEXT_CALLS = new Set([
  "querySelector",
  "querySelectorAll",
  "closest",
  "matches",
  "getElementById",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "setProperty",
  "getPropertyValue",
  "removeProperty",
  "matchMedia",
  "getItem",
  "setItem",
  "removeItem",
  "createLogger",
  "invoke",
  "listen",
  "toggle",
  "add",
  "remove",
  "contains",
  "createIcon",
  "startsWith",
  "endsWith",
  "includes",
  "split",
  "replace",
  "replaceAll",
  "indexOf",
  "has",
  "get",
  "set",
  "delete",
]);
/** setAttribute names whose value is UI text. */
const TEXT_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "aria-placeholder",
  "title",
  "placeholder",
  "alt",
]);
/** Property names (object literal keys, assignment targets) whose value is UI text. */
const TEXT_PROPERTIES = new Set([
  ...TEXT_ATTRIBUTES,
  "textContent",
  "innerText",
  "ariaLabel",
  "label",
  "desc",
  "description",
  "tooltip",
]);
/** Property names whose value is markup plumbing, never text. */
const NON_TEXT_PROPERTIES = new Set([
  "class",
  "className",
  "id",
  "type",
  "role",
  "href",
  "src",
  "rel",
  "target",
  "for",
  "key",
  "style",
  "cssText",
  "autocomplete",
  "inputmode",
  "method",
  "accept",
]);

const posix = (p) => p.split(sep).join("/");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

export function excludedReason(file) {
  return EXCLUDED.find(([re]) => re.test(file))?.[1] ?? null;
}

export function ownerOf(file) {
  return OWNERS.find(([re]) => re.test(file))[1];
}

/** The literal's text, with each template substitution shown as {…}. */
function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.head.text + node.templateSpans.map((s) => "{…}" + s.literal.text).join("");
}

/** A token of code: identifiers, CSS values, class names, paths, numbers. */
const CODE_TOKEN = /^[a-z0-9._%-]+$|[()[\]{}<>=$#@/\\|`]/;

/** Prose by shape. Deliberately conservative on single lowercase words. */
export function looksLikeProse(text) {
  const t = text.replaceAll("{…}", " ").trim();
  if (!/[A-Za-z]{2}/.test(t)) return false;
  if (t.includes("…") || /[A-Za-z]\.\.\.$/.test(t)) return true;
  const words = t.split(/\s+/);
  if (words.length === 1) {
    return /^[A-Z][a-z]+[.!?:]?$/.test(t) || /^[A-Za-z]+[.!?]$/.test(t);
  }
  const bare = words.map((w) => w.replace(/^["'(]+|[.,!?;:"')]+$/g, "")).filter((w) => w !== "");
  // A class list, CSS value or path list: every word is code and at least one
  // is not a plain lowercase word ("settings-pane active", "opacity 0.2s ease").
  if (bare.every((w) => CODE_TOKEN.test(w)) && bare.some((w) => !/^[a-z]+$/.test(w))) return false;
  return /[A-Za-z]{2}/.test(bare.join(""));
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function isLogCall(call) {
  const e = call.expression;
  if (!ts.isPropertyAccessExpression(e) || !LOG_METHODS.has(e.name.text)) return false;
  const obj = e.expression;
  const name = ts.isIdentifier(obj)
    ? obj.text
    : ts.isPropertyAccessExpression(obj)
      ? obj.name.text
      : "";
  return /^console$|log/i.test(name);
}

function propertyName(node) {
  const n = node.name;
  if (n === undefined) return null;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n)) return n.text;
  return null;
}

/**
 * Classify a literal by where it sits. Returns null when the position can
 * never be UI text, otherwise { sink, category }: `sink` means the position
 * alone makes it UI text regardless of shape.
 */
function classify(node) {
  let child = node;
  let parent = node.parent;
  // Look through wrappers that do not change what the value is used for.
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isConditionalExpression(parent) ||
    (ts.isBinaryExpression(parent) &&
      [
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.PlusToken,
      ].includes(parent.operatorToken.kind))
  ) {
    if (ts.isConditionalExpression(parent) && child === parent.condition) break;
    child = parent;
    parent = parent.parent;
  }

  if (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent) ||
    ts.isModuleDeclaration(parent) ||
    ts.isLiteralTypeNode(parent) ||
    ts.isImportTypeNode(parent)
  ) {
    return null;
  }
  // Object keys, enum members and computed keys are names, not values.
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertySignature(parent)) &&
    parent.name === child
  ) {
    return null;
  }
  if (ts.isComputedPropertyName(parent) || ts.isElementAccessExpression(parent)) return null;
  // Comparisons and switch cases test a value; they never display it.
  if (ts.isCaseClause(parent)) return null;
  if (
    ts.isBinaryExpression(parent) &&
    [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.InKeyword,
    ].includes(parent.operatorToken.kind)
  ) {
    return null;
  }

  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    const args = parent.arguments ?? [];
    const index = args.indexOf(child);
    if (ts.isNewExpression(parent)) {
      const ctor = ts.isIdentifier(parent.expression) ? parent.expression.text : "";
      if (/Error$/.test(ctor)) return { sink: false, category: "error" };
      if (/^(URL|RegExp|Intl\.|Worker|BroadcastChannel|CustomEvent|Event)/.test(ctor)) return null;
      return { sink: false, category: "other" };
    }
    if (isLogCall(parent)) return null;
    const name = calleeName(parent);
    if (name === "setText" && index === 1) return { sink: true, category: "text" };
    if (
      (name === "showToast" && index === 0) ||
      (name === "showChangeOutcomeToast" && index === 1)
    ) {
      return { sink: true, category: "toast" };
    }
    if (name === "createElement" && index === 2) return { sink: true, category: "text" };
    if (name === "setAttribute") {
      if (index === 0) return null;
      const attr = args[0];
      if (attr !== undefined && ts.isStringLiteral(attr) && TEXT_ATTRIBUTES.has(attr.text)) {
        return { sink: true, category: "accessible-name" };
      }
      return null;
    }
    if (name !== null && NON_TEXT_CALLS.has(name)) return null;
    if (name === "reject") return { sink: false, category: "error" };
    return { sink: false, category: "other" };
  }
  if (ts.isThrowStatement(parent)) return { sink: false, category: "error" };

  if (ts.isPropertyAssignment(parent)) {
    const key = propertyName(parent);
    if (key !== null && NON_TEXT_PROPERTIES.has(key)) return null;
    if (key !== null && key.startsWith("data-")) return null;
    if (key !== null && TEXT_PROPERTIES.has(key)) {
      return {
        sink: true,
        category: /^(aria-|title$|alt$)/.test(key) ? "accessible-name" : "text",
      };
    }
    return { sink: false, category: "other" };
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === child &&
    ts.isPropertyAccessExpression(parent.left)
  ) {
    const key = parent.left.name.text;
    const target = parent.left.expression;
    if (ts.isPropertyAccessExpression(target) && target.name.text === "style") return null;
    if (NON_TEXT_PROPERTIES.has(key)) return null;
    if (TEXT_PROPERTIES.has(key)) {
      return { sink: true, category: /^(aria|title$|alt$)/.test(key) ? "accessible-name" : "text" };
    }
  }
  return { sink: false, category: "other" };
}

/** The reason on an `i18n-exempt:` comment on the literal's line or a comment-only line above. */
function exemption(sourceLines, line) {
  const m =
    /\/\/\s*i18n-exempt:(.*)$/.exec(sourceLines[line] ?? "") ??
    /^\s*\/\/\s*i18n-exempt:(.*)$/.exec(sourceLines[line - 1] ?? "");
  return m ? m[1].trim() : null;
}

/**
 * Scan one file's source. Returns { findings, errors }: each finding is
 * { line, text, category }; errors are exemptions without a reason.
 */
export function scanSource(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const lines = source.split("\n");
  const findings = [];
  const errors = [];
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const where = classify(node);
      const text = literalText(node);
      if (where !== null && /[A-Za-z]/.test(text) && (where.sink || looksLikeProse(text))) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        const reason = exemption(lines, line);
        if (reason === null) {
          findings.push({ line: line + 1, text, category: where.category });
        } else if (reason === "") {
          errors.push(`${file}:${line + 1}: i18n-exempt needs a reason`);
        }
      }
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { findings, errors };
}

/** Scan src/. Returns { files: { [file]: finding[] }, errors }. */
export function scanTree() {
  const files = {};
  const errors = [];
  for (const path of walk(SRC).sort()) {
    const file = posix(relative(CLIENT, path));
    if (excludedReason(file) !== null) continue;
    const result = scanSource(file, readFileSync(path, "utf8"));
    errors.push(...result.errors);
    if (result.findings.length > 0) files[file] = result.findings;
  }
  return { files, errors };
}

function counts(findings) {
  const out = {};
  for (const f of findings) out[f.text] = (out[f.text] ?? 0) + 1;
  return out;
}

/** The baseline, or null when the file does not exist yet. */
export function loadBaseline() {
  return existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : null;
}

/**
 * Compare a scan with the baseline. `added` are literals above their baseline
 * count (with every line of that text, since which occurrence is new cannot be
 * known); `stale` are baseline entries above the scanned count.
 */
export function compare(scan, baseline) {
  baseline ??= {};
  const added = [];
  const stale = [];
  for (const [file, findings] of Object.entries(scan.files)) {
    const allowed = baseline[file]?.strings ?? {};
    for (const [text, n] of Object.entries(counts(findings))) {
      if (n > (allowed[text] ?? 0)) {
        for (const f of findings.filter((x) => x.text === text)) added.push({ file, ...f });
      }
    }
  }
  for (const [file, entry] of Object.entries(baseline)) {
    const actual = counts(scan.files[file] ?? []);
    for (const [text, n] of Object.entries(entry.strings)) {
      if (n > (actual[text] ?? 0))
        stale.push({ file, text, baseline: n, actual: actual[text] ?? 0 });
    }
  }
  return { added, stale };
}

/**
 * The shrunk baseline: every entry capped at its scanned count, empties
 * dropped. Never adds, even to an empty baseline. Only with no baseline file
 * (null) does it record the whole scan, which is how the inventory was first
 * taken.
 */
export function shrink(scan, baseline) {
  const fresh = baseline === null;
  const out = {};
  for (const [file, findings] of Object.entries(scan.files)) {
    const actual = counts(findings);
    const strings = {};
    for (const text of Object.keys(actual).sort()) {
      const cap = fresh ? actual[text] : Math.min(actual[text], baseline[file]?.strings[text] ?? 0);
      if (cap > 0) strings[text] = cap;
    }
    if (Object.keys(strings).length > 0) out[file] = { owner: ownerOf(file), strings };
  }
  return out;
}

function report(scan) {
  const rows = Object.entries(scan.files).map(([file, findings]) => {
    const by = {};
    for (const f of findings) by[f.category] = (by[f.category] ?? 0) + 1;
    return { file, owner: ownerOf(file), total: findings.length, by };
  });
  const cats = ["text", "accessible-name", "toast", "error", "other"];
  const lines = [
    `| File | Owner | Total | ${cats.join(" | ")} |`,
    `| --- | --- | ---: | ${cats.map(() => "---:").join(" | ")} |`,
    ...rows.map(
      (r) =>
        `| \`${r.file}\` | ${r.owner} | ${r.total} | ${cats.map((c) => r.by[c] ?? 0).join(" | ")} |`,
    ),
  ];
  const owners = {};
  for (const r of rows) {
    owners[r.owner] ??= { files: 0, total: 0 };
    owners[r.owner].files++;
    owners[r.owner].total += r.total;
  }
  lines.push("", "| Owner | Files | Literals |", "| --- | ---: | ---: |");
  for (const [o, v] of Object.entries(owners).sort())
    lines.push(`| ${o} | ${v.files} | ${v.total} |`);
  return lines.join("\n");
}

function main(argv) {
  const scan = scanTree();
  if (scan.errors.length > 0) {
    console.error(scan.errors.join("\n"));
    return 1;
  }
  if (argv.includes("--report")) {
    console.log(report(scan));
    return 0;
  }
  const baseline = loadBaseline();
  if (argv.includes("--update")) {
    writeFileSync(BASELINE_PATH, JSON.stringify(shrink(scan, baseline), null, 2) + "\n");
    console.log(`wrote ${relative(CLIENT, BASELINE_PATH)}`);
  }
  const { added, stale } = compare(scan, argv.includes("--update") ? loadBaseline() : baseline);
  for (const a of added) {
    console.error(`${a.file}:${a.line}: new UI text ${JSON.stringify(a.text)}`);
  }
  if (added.length > 0) {
    console.error(
      "\nMove it to a catalog under src/i18n/, or mark it `// i18n-exempt: <reason>` if it is not app copy.",
    );
  }
  for (const s of stale) {
    console.error(
      `${s.file}: baseline lists ${JSON.stringify(s.text)} ×${s.baseline}, source has ${s.actual}`,
    );
  }
  if (stale.length > 0)
    console.error("\nRun `node scripts/check-ui-strings.mjs --update` to shrink the baseline.");
  return added.length > 0 || stale.length > 0 ? 1 : 0;
}

if (process.argv[1] === import.meta.filename) process.exit(main(process.argv.slice(2)));
