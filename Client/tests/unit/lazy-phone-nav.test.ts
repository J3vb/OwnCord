import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { installGestures, installBack } = vi.hoisted(() => ({
  installGestures: vi.fn(),
  installBack: vi.fn(),
}));
vi.mock("../../src/pages/main-page/phoneGestures", () => ({
  installPhoneGestures: installGestures,
}));
vi.mock("../../src/pages/main-page/overlayBack", () => ({ installOverlayBack: installBack }));

import { installPhoneNavWhenPhone } from "../../src/pages/main-page/lazyPhoneNav";

let phone = true;
let ac: AbortController;

function options(): Parameters<typeof installPhoneNavWhenPhone>[0] {
  const el = document.createElement("div");
  return {
    signal: ac.signal,
    root: el,
    chatArea: el,
    drawerSurfaces: [el],
    memberColumn: el,
    drawer: () => null,
    members: () => null,
    closeView: () => undefined,
  };
}

beforeEach(() => {
  phone = true;
  ac = new AbortController();
  installGestures.mockClear();
  installBack.mockClear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: phone })),
  );
});

afterEach(() => {
  ac.abort();
  vi.unstubAllGlobals();
});

describe("installPhoneNavWhenPhone", () => {
  it("loads and installs the swipes and the overlay Back on a phone", async () => {
    const opts = options();
    installPhoneNavWhenPhone(opts);
    await vi.dynamicImportSettled();
    expect(installGestures).toHaveBeenCalledTimes(1);
    expect(installGestures).toHaveBeenCalledWith(opts);
    expect(installBack).toHaveBeenCalledWith({
      signal: ac.signal,
      root: opts.root,
      closeView: opts.closeView,
    });
  });

  it("loads nothing off the phone layout, and installs once it becomes one", async () => {
    phone = false;
    installPhoneNavWhenPhone(options());
    await vi.dynamicImportSettled();
    expect(installGestures).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("resize"));
    await vi.dynamicImportSettled();
    expect(installGestures).not.toHaveBeenCalled();
    phone = true;
    window.dispatchEvent(new Event("resize"));
    await vi.dynamicImportSettled();
    expect(installGestures).toHaveBeenCalledTimes(1);
    // Later resizes do not install again.
    window.dispatchEvent(new Event("resize"));
    await vi.dynamicImportSettled();
    expect(installGestures).toHaveBeenCalledTimes(1);
    expect(installBack).toHaveBeenCalledTimes(1);
  });

  it("installs nothing if the page went away while the code loaded", async () => {
    installPhoneNavWhenPhone(options());
    ac.abort();
    await vi.dynamicImportSettled();
    expect(installGestures).not.toHaveBeenCalled();
    expect(installBack).not.toHaveBeenCalled();
  });

  it("stops listening for resizes when the page goes away", async () => {
    phone = false;
    installPhoneNavWhenPhone(options());
    ac.abort();
    phone = true;
    window.dispatchEvent(new Event("resize"));
    await vi.dynamicImportSettled();
    expect(installGestures).not.toHaveBeenCalled();
  });
});
