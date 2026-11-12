// In-page clocks and fixtures for the chat and server baseline
// (fullstack/non-media-performance.measure.ts). A clock is armed first and
// read after the action, so the time is taken inside the page when the event
// or the DOM change happens, not when a Playwright poll notices it.
import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { seededRandom } from "../../../scripts/perf-stats.mjs";

type ClockWindow = typeof window & { __ocClocks?: Record<string, Promise<number | null>> };

export interface Appearance {
  /** CSS selector of the element to wait for. */
  readonly selector: string;
  /** Text the element must contain. */
  readonly text?: string;
}

/**
 * Starts waiting, inside the page, for an element matching `what`; the clock
 * reads the page's wall clock (Date.now()) when it first matches, or null
 * after `timeoutMs`. An element already there when armed counts at once.
 */
export async function armAppearance(page: Page, key: string, what: Appearance, timeoutMs = 30_000) {
  await page.evaluate(
    ([k, w, timeout]) => {
      const clocks = ((window as ClockWindow).__ocClocks ??= {});
      const found = () =>
        [...document.querySelectorAll(w.selector)].some(
          (el) => w.text === undefined || (el.textContent ?? "").includes(w.text),
        );
      clocks[k] = new Promise((resolve) => {
        if (found()) return resolve(Date.now());
        const observer = new MutationObserver(() => {
          if (!found()) return;
          const at = Date.now();
          observer.disconnect();
          clearTimeout(timer);
          resolve(at);
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, timeout);
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["class"],
          characterData: true,
        });
      });
    },
    [key, what, timeoutMs] as const,
  );
}

/** Starts waiting for the next `type` event on an element matching `selector` (capture phase). */
export async function armEvent(page: Page, key: string, type: string, selector: string) {
  await page.evaluate(
    ([k, t, s]) => {
      const clocks = ((window as ClockWindow).__ocClocks ??= {});
      clocks[k] = new Promise((resolve) => {
        const listener = (event: Event) => {
          if (!(event.target instanceof Element) || !event.target.closest(s)) return;
          if (event instanceof KeyboardEvent && t === "keydown" && event.key !== "Enter") return;
          document.removeEventListener(t, listener, true);
          resolve(Date.now());
        };
        document.addEventListener(t, listener, true);
      });
    },
    [key, type, selector] as const,
  );
}

/** The time an armed clock stopped, in epoch milliseconds, or null if it timed out. */
export function clockAt(page: Page, key: string): Promise<number | null> {
  return page.evaluate((k) => (window as ClockWindow).__ocClocks![k]!, key);
}

export const elapsed = (from: number | null, to: number | null): number | null =>
  from === null || to === null ? null : to - from;

/** Deterministic file content for one seed: the same seed gives the same bytes and hash. */
export function seededFile(seed: number, bytes: number): { buffer: Buffer; sha256: string } {
  const random = seededRandom(seed);
  const buffer = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buffer[i] = Math.floor(random() * 256);
  return { buffer, sha256: createHash("sha256").update(buffer).digest("hex") };
}

/** Whether nothing accepts a TCP connection on the port (the server is really down). */
export function portClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}
