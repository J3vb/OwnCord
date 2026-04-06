/**
 * Phase B Step 6 — Solid pipeline smoke test.
 *
 * Verifies that the Vite + Solid + Vitest configuration actually compiles
 * and renders a component end-to-end. This test only exists to prove the
 * pipeline; the test scope expands as more components migrate.
 */

import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { Badge } from "./Badge";

describe("Badge (solid)", () => {
  it("renders the label", () => {
    const { getByText } = render(() => <Badge label="online" variant="online" />);
    expect(getByText("online")).toBeTruthy();
  });

  it("invokes onClick when activated", () => {
    let clicked = 0;
    const { getByText } = render(() => (
      <Badge label="press me" onClick={() => clicked++} />
    ));
    getByText("press me").click();
    expect(clicked).toBe(1);
  });
});
