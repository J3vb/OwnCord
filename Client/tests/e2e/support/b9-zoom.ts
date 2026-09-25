/**
 * B9 OS 200 % zoom / reflow check (WCAG 1.4.4 Resize Text, 1.4.10 Reflow).
 *
 * Model: an effective 200 % page zoom is rendered as a 640×400 CSS viewport at
 * `deviceScaleFactor: 1`. Page zoom halves the CSS layout viewport — a
 * 1280×800 window becomes 640×400 CSS px — so media queries and layout see
 * exactly what a zoomed user sees. `deviceScaleFactor: 2` alone changes only
 * the physical pixel ratio and leaves the CSS viewport at its full size, so it
 * does not exercise reflow; that is why this helper does not use it. The model
 * and its reason are recorded in `docs/architecture/b9-ui-contract.md` (Q1:
 * "OS zoom 200 %, the 940×500 minimum window — nothing clipped or
 * unreachable").
 *
 * A screen is audited for the 1.4.10 failures the B9 lanes name:
 *
 * - no horizontal page scroll (`expectNoTwoDimensionalScroll`);
 * - text-bearing elements and controls are not clipped by their own box
 *   (`scrollWidth > clientWidth`) nor by a clipping ancestor;
 * - visible interactive elements are not painted over by another element
 *   inside the same screen root;
 * - every primary action is reachable (`scrollIntoViewIfNeeded` +
 *   `toBeInViewport`).
 *
 * The audit is scoped to a screen root, never the whole document, so an open
 * dialog's backdrop is not reported as covering the shell behind it and a
 * collapsed global sidebar is not charged to a feature screen. One screenshot
 * per screen is attached as the test artifact.
 */

import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect } from "@playwright/test";

/** The effective 200 % zoom viewport: a 1280×800 window at 200 % page zoom. */
export const ZOOM_VIEWPORT = { width: 640, height: 400 } as const;

const INTERACTIVE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"], [role="switch"], [role="radio"], [role="tab"], [role="combobox"], [role="checkbox"]';

export interface ReflowAudit {
  readonly pageOverflow: number;
  readonly clipped: readonly string[];
  readonly covered: readonly string[];
}

/**
 * Audit one screen root at the zoom viewport, in a single page round trip.
 * `root` bounds both clipping ancestry and overlap: an element is never
 * charged to an ancestor or a covering element outside the root.
 */
export async function auditReflow(root: Locator): Promise<ReflowAudit> {
  return root.evaluate(
    (node, selectors) => {
      const interactive = selectors.interactive;
      const label = (el: Element): string => {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
        const cls =
          typeof el.className === "string" ? el.className.split(" ").slice(0, 2).join(".") : "";
        return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}${text ? ` "${text}"` : ""}`;
      };
      // Painted: not hidden by the element's own or any ancestor's display,
      // visibility or opacity. An ancestor chain up to (and including) the
      // screen root, so a hidden global region is not charged to a screen.
      const isPainted = (el: Element): boolean => {
        for (let n: Element | null = el; n !== null; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0")
            return false;
          if (n === node) break;
        }
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      // Hit-testable: painted and not under a `pointer-events: none` ancestor.
      // A hover/focus-revealed action bar (`opacity: 0; pointer-events: none`
      // until `:focus-within`) is keyboard-reachable, so its controls are not
      // "covered" — they are simply not painted until revealed.
      const isHitTestable = (el: Element): boolean => {
        if (!isPainted(el)) return false;
        for (let n: Element | null = el; n !== null; n = n.parentElement) {
          if (getComputedStyle(n).pointerEvents === "none") return false;
          if (n === node) break;
        }
        return true;
      };
      // An intended horizontal scroll or truncation keeps its content, so its
      // overrun is not a reflow defect.
      const isIntendedOverflow = (el: Element): boolean => {
        const cs = getComputedStyle(el);
        if (cs.overflowX === "auto" || cs.overflowX === "scroll") return true;
        if (cs.textOverflow === "ellipsis") return true;
        if (cs.webkitLineClamp && cs.webkitLineClamp !== "none") return true;
        return el.classList.contains("sr-only");
      };
      // A sink renders text it directly owns; a wrapper whose overrun comes only
      // from a child is not charged here.
      const isTextSink = (el: Element): boolean =>
        [...el.childNodes].some(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "",
        );

      const clipped: string[] = [];
      for (const el of node.querySelectorAll<HTMLElement>("*")) {
        if (!isPainted(el)) continue;
        if (!isTextSink(el) && !el.matches(interactive)) continue;
        if (isIntendedOverflow(el)) continue;
        if (el.scrollWidth > el.clientWidth + 1) {
          clipped.push(`${label(el)} (own box ${el.scrollWidth}>${el.clientWidth})`);
          continue;
        }
        // Overflow into a clipping ancestor: the element's own box fits, but an
        // ancestor with overflow other than visible cuts it off sideways. A
        // scrollable ancestor is not a clip: the content is reachable by
        // scrolling that ancestor.
        const r = el.getBoundingClientRect();
        for (
          let p = el.parentElement;
          p !== null && p !== node.parentElement;
          p = p.parentElement
        ) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === "visible") continue;
          if (ox === "auto" || ox === "scroll") break;
          const q = p.getBoundingClientRect();
          if (r.left < q.left - 1 || r.right > q.right + 1) {
            clipped.push(`${label(el)} (clipped by ${label(p)})`);
            break;
          }
        }
      }

      // A control is covered when the element painted at its centre is a
      // different element still inside this screen root. Only hit-testable
      // controls are considered: a hidden hover-reveal bar is keyboard-reachable
      // and is not a pointer target until revealed.
      const covered: string[] = [];
      for (const el of node.querySelectorAll<HTMLElement>(interactive)) {
        if (!isHitTestable(el)) continue;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
        const top = document.elementFromPoint(x, y);
        if (top === null || top === el || el.contains(top)) continue;
        if (!node.contains(top)) continue;
        covered.push(`${label(el)} covered by ${label(top)}`);
      }

      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        clipped: [...new Set(clipped)],
        covered: [...new Set(covered)],
      };
    },
    { interactive: INTERACTIVE },
  );
}

/** Fail when the page scrolls sideways at all (1.4.10). */
export async function expectNoTwoDimensionalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal page scroll at 200 % zoom").toBe(0);
}

export interface ZoomScreen {
  /** Screenshot artifact name, e.g. `zoom-shell-640x400.png`. */
  readonly name: string;
  /** The screen's own container; the audit never leaves it. */
  readonly root: Locator;
  /** Primary actions that must stay reachable. */
  readonly actions: readonly Locator[];
}

/**
 * Audit one screen at the 200 % zoom viewport: no horizontal page scroll, no
 * text or control clipped without an intended scroll area, no control painted
 * over within the screen, every primary action reachable, and one screenshot.
 */
export async function expectScreenReflows(
  page: Page,
  screen: ZoomScreen,
  testInfo: TestInfo,
): Promise<void> {
  await expectNoTwoDimensionalScroll(page);
  const audit = await auditReflow(screen.root);
  expect(audit.clipped, `clipped at 200 % zoom (${screen.name})`).toEqual([]);
  expect(audit.covered, `controls covered at 200 % zoom (${screen.name})`).toEqual([]);
  for (const action of screen.actions) {
    await action.scrollIntoViewIfNeeded();
    await expect(action, `unreachable at 200 % zoom (${screen.name})`).toBeInViewport();
  }
  await testInfo.attach(screen.name, {
    body: await page.screenshot(),
    contentType: "image/png",
  });
}
