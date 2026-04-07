/**
 * Vitest global setup for Solid.js component tests (T-500).
 *
 * Loaded via `test.setupFiles` in vitest.config.ts so every test suite
 * automatically gets Solid's afterEach cleanup without having to import
 * or call it manually.
 *
 * Add future Solid testing helpers here (custom matchers, query extensions,
 * aria-query configuration, etc.). Do NOT import application code here —
 * this file executes once before every test suite, including non-Solid suites.
 *
 * Security note: Solid JSX auto-escapes interpolated values ({expr}), so
 * user-controlled strings passed through JSX are safe. Never use innerHTML,
 * insertAdjacentHTML, or dangerouslySetInnerHTML in Solid components.
 */
import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

// Register cleanup after every test so Solid reactive roots are disposed
// and host DOM nodes are removed. Without this, roots accumulate across tests
// and can cause state leakage between test cases.
afterEach(cleanup);
