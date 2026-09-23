// B9-3: the UI string inventory is a shrink-only ratchet.
//
// scripts/check-ui-strings.mjs finds UI text in src/ by syntax-tree position
// and prose shape; scripts/ui-strings-baseline.json lists what B9-18/19/20
// still have to move into src/i18n/. New UI text fails here, and so does a
// baseline entry the source no longer has. The fixture cases below prove the
// scan catches each sink it claims and pin the limits it documents.
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compare,
  loadBaseline,
  ownerOf,
  scanSource,
  scanTree,
  shrink,
  type Scan,
} from "../../scripts/check-ui-strings.mjs";

const clientRoot = path.resolve(__dirname, "../..");

const texts = (source: string): string[] =>
  scanSource("src/fixture.ts", source).findings.map((f) => f.text);

describe("UI string inventory", () => {
  const scan = scanTree();
  const baseline = loadBaseline() ?? {};

  it("has no new UI text and no stale baseline entry", () => {
    expect(scan.errors).toEqual([]);
    const { added, stale } = compare(scan, baseline);
    expect(
      added.map((a) => `${a.file}:${a.line} ${JSON.stringify(a.text)}`),
      "new UI text: move it to a catalog under src/i18n/, or mark it `// i18n-exempt: <reason>`",
    ).toEqual([]);
    expect(
      stale.map((s) => `${s.file} ${JSON.stringify(s.text)}`),
      "run `node scripts/check-ui-strings.mjs --update` to shrink the baseline",
    ).toEqual([]);
  });

  it("names an existing file and its owning milestone for every baseline entry", () => {
    for (const [file, entry] of Object.entries(baseline)) {
      expect(existsSync(path.join(clientRoot, file)), file).toBe(true);
      expect(entry.owner, file).toBe(ownerOf(file));
      expect(["B9-18", "B9-19", "B9-20"]).toContain(entry.owner);
    }
  });

  it("holds nothing for the extracted pilot", () => {
    expect(scan.files["src/components/settings/AccessibilityTab.ts"]).toBeUndefined();
    expect(baseline["src/components/settings/AccessibilityTab.ts"]).toBeUndefined();
  });
});

describe("the scan", () => {
  it("catches text in every sink it claims, whatever its shape", () => {
    expect(
      texts(`
        setText(el, "general");
        el.textContent = "done";
        el.title = "copy";
        createElement("button", { "aria-label": "close", class: "x" }, "save");
        el.setAttribute("placeholder", "search");
        showToast(\`Deleted \${n} messages\`, "error");
        const row = { label: "mute", desc: "quiet" };
      `),
    ).toEqual([
      "general",
      "done",
      "copy",
      "close",
      "save",
      "search",
      "Deleted {…} messages",
      "mute",
      "quiet",
    ]);
  });

  it("catches prose anywhere else", () => {
    expect(
      texts(`
        const a = "Are you sure?";
        const b = "an error occurred";
        const c = cond ? "Online" : "Offline";
        throw new Error("Upload failed");
        const d = \`Loading…\`;
      `),
    ).toEqual([
      "Are you sure?",
      "an error occurred",
      "Online",
      "Offline",
      "Upload failed",
      "Loading…",
    ]);
  });

  it("ignores code-shaped strings and non-UI positions", () => {
    expect(
      texts(`
        import { x } from "./Some Module";
        type T = "Hello World";
        const el = createElement("div", { class: "settings-pane active", role: "Dialog" });
        log.info("Connecting to the server now");
        console.warn("Something went wrong");
        if (e.key === "Escape") {}
        switch (s) { case "Online": break; }
        document.querySelector(".modal .Close");
        el.style.transition = "Opacity 0.2s ease";
        el.setAttribute("role", "Status");
        const css = "opacity 0.2s ease";
        const media = "(prefers-reduced-motion: reduce)";
        const map = { "Content-Type": "application/json" };
      `),
    ).toEqual([]);
  });

  it("honours an exemption only when it carries a reason", () => {
    const result = scanSource(
      "src/fixture.ts",
      `
        // i18n-exempt: protocol error code, mapped by the caller
        const a = "Rate Limited";
        const b = "Rate Limited"; // i18n-exempt:
      `,
    );
    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual(["src/fixture.ts:4: i18n-exempt needs a reason"]);
  });

  it("does not carry a trailing exemption over to the next line", () => {
    expect(
      texts(`
        const code = "Rate Limited"; // i18n-exempt: wire code
        setText(el, "Upload failed, try again");
      `),
    ).toEqual(["Upload failed, try again"]);
  });

  it("does not follow a value through a variable (documented limit)", () => {
    expect(texts(`const name = "general"; setText(el, name);`)).toEqual([]);
  });
});

describe("the baseline ratchet", () => {
  const scanOf = (...lines: [number, string][]): Scan => ({
    files: { "src/a.ts": lines.map(([line, text]) => ({ line, text, category: "text" })) },
    errors: [],
  });
  const baseline = { "src/a.ts": { owner: "B9-20", strings: { Save: 1 } } };

  it("fails a second copy of baselined text on every line that has it", () => {
    const { added, stale } = compare(scanOf([3, "Save"], [9, "Save"]), baseline);
    expect(added.map((a) => a.line)).toEqual([3, 9]);
    expect(stale).toEqual([]);
  });

  it("fails a baseline entry the source no longer has", () => {
    const { added, stale } = compare(scanOf(), baseline);
    expect(added).toEqual([]);
    expect(stale).toEqual([{ file: "src/a.ts", text: "Save", baseline: 1, actual: 0 }]);
  });

  it("only shrinks an existing baseline", () => {
    expect(shrink(scanOf([3, "Save"], [5, "Cancel"]), baseline)).toEqual(baseline);
    expect(shrink(scanOf(), baseline)).toEqual({});
  });

  it("never reseeds an empty baseline, only a missing one", () => {
    expect(shrink(scanOf([3, "Retry now"]), {})).toEqual({});
    expect(shrink(scanOf([3, "Retry now"]), null)).toEqual({
      "src/a.ts": { owner: ownerOf("src/a.ts"), strings: { "Retry now": 1 } },
    });
  });
});
