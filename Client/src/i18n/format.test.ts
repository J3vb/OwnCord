import { afterEach, describe, expect, it } from "vitest";
import {
  defineCatalog,
  expandText,
  formatDate,
  formatNumber,
  setTextTransformForTesting,
} from "./format";
import { settingsText } from "./settings";

const text = defineCatalog("test", {
  plain: "Reduce Motion",
  greet: "Hello {name}, you have {items} items",
  unread: {
    one: "{count} unread message in {channel}",
    other: "{count} unread messages in {channel}",
  },
});

afterEach(() => {
  setTextTransformForTesting(null);
});

describe("defineCatalog", () => {
  it("returns the English entry for a key", () => {
    expect(text("plain")).toBe("Reduce Motion");
  });

  it("inserts parameters verbatim and formats numbers in the catalog locale", () => {
    expect(text("greet", { name: "<b>Ana</b> {items}", items: 12345 })).toBe(
      "Hello <b>Ana</b> {items}, you have 12,345 items",
    );
  });

  it("picks the English plural branch for zero, one and many", () => {
    expect(text("unread", { count: 0, channel: "#general" })).toBe("0 unread messages in #general");
    expect(text("unread", { count: 1, channel: "#general" })).toBe("1 unread message in #general");
    expect(text("unread", { count: 2500, channel: "#general" })).toBe(
      "2,500 unread messages in #general",
    );
  });

  it("types keys and placeholders", () => {
    // @ts-expect-error — a key the catalog does not define
    expect(text("missing")).toBe("test.missing");
    // @ts-expect-error — a required placeholder is not supplied
    expect(text("greet", { name: "Ana" })).toBe("Hello Ana, you have {items} items");
    // @ts-expect-error — a plural entry needs its count
    expect(text("unread", { channel: "#x" })).toBe("{count} unread messages in #x");
    // @ts-expect-error — a plain entry takes no parameters
    expect(text("plain", { name: "x" })).toBe("Reduce Motion");
  });

  it("does not resolve inherited object keys", () => {
    // @ts-expect-error — a prototype property is not a catalog key
    expect(text("toString")).toBe("test.toString");
  });
});

describe("expansion", () => {
  it("lengthens the template by about 40 % and brackets it", () => {
    const out = expandText("Reduce Motion");
    expect(out.startsWith("⟦Reduce Motion ")).toBe(true);
    expect(out.endsWith("⟧")).toBe(true);
    expect(out.length).toBeGreaterThanOrEqual(Math.ceil("Reduce Motion".length * 1.4));
  });

  it("keeps placeholders and never expands parameter values", () => {
    setTextTransformForTesting(expandText);
    const out = text("unread", { count: 3, channel: "#general" });
    expect(out.startsWith("⟦3 unread messages in #general ")).toBe(true);
    expect(out).not.toContain("{");
    expect(out.match(/#general/g)).toHaveLength(1);
  });

  it("applies to real catalogs and switches back to English", () => {
    setTextTransformForTesting(expandText);
    expect(settingsText("accessibility.largeFont.label")).toMatch(/^⟦Large Font .+⟧$/);
    setTextTransformForTesting(null);
    expect(settingsText("accessibility.largeFont.label")).toBe("Large Font");
  });
});

describe("formatting", () => {
  it("formats numbers and dates in en-US regardless of the host locale", () => {
    expect(formatNumber(1234567.5)).toBe("1,234,567.5");
    expect(formatNumber(0.42, { style: "percent" })).toBe("42%");
    expect(
      formatDate(Date.UTC(2026, 8, 23, 14, 5), {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }),
    ).toBe("Sep 23, 2026");
  });
});
