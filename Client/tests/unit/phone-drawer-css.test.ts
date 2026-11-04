// The phone drawer's layout is CSS, and jsdom never applies it, so these read
// the parsed stylesheet (Lightning CSS, as tests/helpers/app-css.ts does) and
// walk the @media rules that helper leaves out.
import { describe, expect, it } from "vitest";
import { flatMediaRules } from "../helpers/appCssMedia";

const rules = flatMediaRules().map((r) => ({
  ...r,
  declarations: JSON.stringify(r.declarations),
}));
type FlatRule = (typeof rules)[number];

/** The media text of the phone layout: a touch screen that is narrow or short. */
const isPhoneMedia = (r: FlatRule): boolean =>
  // Exactly the phone query's two halves: a rule that also lists the plain
  // 800 px width is the narrow-window rule, not a phone-only one.
  r.queries.length === 2 &&
  r.queries.every((q) => q.includes('"name":"pointer"') && q.includes('"coarse"')) &&
  r.media.includes('"name":"width"') &&
  r.media.includes('"value":899') &&
  r.media.includes('"name":"height"') &&
  r.media.includes('"value":499');

function phoneRule(selector: string): FlatRule | undefined {
  return rules.find((r) => r.selector === selector && isPhoneMedia(r));
}

describe("the server rail in the phone drawer", () => {
  it("stays hidden in a narrow window, whatever the pointer", () => {
    // One query of the rule is the plain 800 px width, with no pointer in it.
    const hiding = rules.filter(
      (r) =>
        r.selector === ".server-rail-slot" &&
        r.queries.some((q) => q.includes('"value":800') && !q.includes("coarse")) &&
        r.declarations.includes('"none"'),
    );
    expect(hiding.length).toBeGreaterThan(0);
  });

  it("shows as a fixed column on the drawer's left, in the drawer's layer, only while the drawer is open", () => {
    const shown = phoneRule(".server-rail-slot.drawer-open");
    expect(shown).toBeDefined();
    expect(shown!.declarations).toContain('"flex"');
    expect(shown!.declarations).toContain('"fixed"');
    expect(shown!.declarations).toContain("100");
    // No rule shows the slot on a phone without the drawer being open.
    expect(phoneRule(".server-rail-slot")?.declarations ?? "").not.toContain('"flex"');
  });

  it("is about 72 px wide, with touch-sized buttons", () => {
    const width = phoneRule(".app.has-server-rail");
    expect(width?.declarations).toContain("--drawer-rail-width");
    expect(width?.declarations).toContain("72");
    const button = phoneRule(".server-rail-slot.drawer-open .server-rail-btn");
    expect(button?.declarations).toContain("48");
  });

  it("moves the channel list to the rail's right", () => {
    const list = phoneRule(".app.has-server-rail .unified-sidebar.drawer-open");
    expect(list).toBeDefined();
    expect(list!.declarations).toContain("--drawer-rail-width");
  });

  it("replaces the user bar's Switch server button on a phone", () => {
    const rule = phoneRule('.app.has-server-rail .user-bar [data-testid="disconnect-btn"]');
    expect(rule).toBeDefined();
    expect(rule!.declarations).toContain('"none"');
    // The portal has no rail class, so its button is not matched here.
    expect(rule!.selector).toContain(".has-server-rail");
  });
});

describe("the drawer's search button", () => {
  it("is hidden by default and shown only in the open phone drawer", () => {
    const hidden = rules.find((r) => r.selector === ".sidebar-drawer-search" && r.media === "");
    expect(hidden?.declarations).toContain('"none"');
    const shown = phoneRule(".unified-sidebar.drawer-open .sidebar-drawer-search");
    expect(shown?.declarations).toContain('"flex"');
    // Touch-sized.
    expect(shown?.declarations).toContain("44");
  });
});

describe("touch-action for the swipes", () => {
  it("lets the browser scroll vertically and zoom, and leaves horizontal moves to the page", () => {
    for (const selector of [
      ".chat-area",
      ".messages-container",
      ".unified-sidebar",
      ".channel-list",
      ".member-column",
      ".member-column-body",
      ".server-rail-slot",
    ]) {
      const rule = phoneRule(selector);
      expect(rule, selector).toBeDefined();
      expect(rule!.declarations).toContain("touch-action");
      expect(rule!.declarations).toContain("pan-y");
    }
  });
});
