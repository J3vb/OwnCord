import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PANEL_SWIPE_PX,
  REPLY_FOLLOW_MAX_PX,
  REPLY_THRESHOLD_PX,
  installPhoneGestures,
} from "../../src/pages/main-page/phoneGestures";
import { pointer, swipe } from "../helpers/touch";

let phone = true;
const owners: AbortController[] = [];

interface Fixture {
  readonly chat: HTMLElement;
  readonly sidebar: HTMLElement;
  readonly rail: HTMLElement;
  readonly members: HTMLElement;
  readonly drawer: { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  readonly panel: {
    openOverlay: ReturnType<typeof vi.fn>;
    closeOverlay: ReturnType<typeof vi.fn>;
  };
  readonly state: { drawerOpen: boolean; membersOpen: boolean };
  readonly reply: ReturnType<typeof vi.fn>;
}

function fixture(): Fixture {
  document.body.innerHTML = `
    <aside id="sidebar"><button id="channel">general</button></aside>
    <div id="rail"><button id="server">S</button></div>
    <div id="chat">
      <div class="messages-region">
        <div class="messages-container">
          <div class="message" data-testid="message-5">
            <span id="body5">hello</span>
            <div class="msg-actions-bar"><button data-testid="msg-reply-5">Reply</button></div>
          </div>
          <div class="message" data-testid="message-6"><span id="body6">no reply here</span></div>
        </div>
      </div>
      <div id="header"><span id="title">general</span></div>
      <textarea id="composer"></textarea>
    </div>
    <aside id="members"><span id="who">alex</span></aside>`;
  const state = { drawerOpen: false, membersOpen: false };
  const drawer = {
    open: vi.fn(() => {
      state.drawerOpen = true;
    }),
    close: vi.fn(() => {
      state.drawerOpen = false;
    }),
  };
  const panel = {
    openOverlay: vi.fn(() => {
      state.membersOpen = true;
      return true;
    }),
    closeOverlay: vi.fn(() => {
      state.membersOpen = false;
    }),
  };
  const ac = new AbortController();
  owners.push(ac);
  const get = (id: string): HTMLElement => document.getElementById(id)!;
  const reply = vi.fn();
  get("chat").querySelector('[data-testid="msg-reply-5"]')!.addEventListener("click", reply);
  const sidebar = get("sidebar");
  const rail = get("rail");
  const members = get("members");
  installPhoneGestures({
    signal: ac.signal,
    chatArea: get("chat"),
    drawerSurfaces: [sidebar, rail],
    memberColumn: members,
    drawer: () => ({ ...drawer, isOpen: () => state.drawerOpen }),
    members: () => ({ ...panel, isOverlayOpen: () => state.membersOpen }),
  });
  return { chat: get("chat"), sidebar, rail, members, drawer, panel, state, reply };
}

beforeEach(() => {
  phone = true;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: phone })),
  );
});

afterEach(() => {
  for (const ac of owners.splice(0)) ac.abort();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const at = (id: string): Element => document.getElementById(id)!;

describe("swipes on the chat", () => {
  it("a right swipe opens the drawer, and a short one does not", () => {
    const f = fixture();
    swipe(at("title"), [50, 100], [50 + PANEL_SWIPE_PX - 5, 100]);
    expect(f.drawer.open).not.toHaveBeenCalled();
    swipe(at("title"), [50, 100], [50 + PANEL_SWIPE_PX, 104]);
    expect(f.drawer.open).toHaveBeenCalledTimes(1);
    expect(f.panel.openOverlay).not.toHaveBeenCalled();
  });

  it("a left swipe opens the member list", () => {
    const f = fixture();
    swipe(at("title"), [300, 100], [300 - PANEL_SWIPE_PX, 100]);
    expect(f.panel.openOverlay).toHaveBeenCalledTimes(1);
    expect(f.drawer.open).not.toHaveBeenCalled();
  });

  it("a right swipe that starts on a message opens the drawer, and its row stays put", () => {
    const f = fixture();
    swipe(at("body5"), [50, 100], [180, 100]);
    expect(f.drawer.open).toHaveBeenCalledTimes(1);
    expect(f.reply).not.toHaveBeenCalled();
    expect((at("body5").closest(".message") as HTMLElement).style.transform).toBe("");
  });

  it("a left swipe on a message without a reply button opens the member list", () => {
    const f = fixture();
    swipe(at("body6"), [300, 100], [200, 100]);
    expect(f.panel.openOverlay).toHaveBeenCalledTimes(1);
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("does nothing off the phone layout", () => {
    phone = false;
    const f = fixture();
    swipe(at("title"), [50, 100], [200, 100]);
    swipe(at("title"), [300, 100], [100, 100]);
    swipe(at("body5"), [300, 100], [100, 100]);
    expect(f.drawer.open).not.toHaveBeenCalled();
    expect(f.panel.openOverlay).not.toHaveBeenCalled();
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("follows the layout as it changes, without a reinstall", () => {
    phone = false;
    const f = fixture();
    swipe(at("title"), [50, 100], [200, 100]);
    expect(f.drawer.open).not.toHaveBeenCalled();
    phone = true;
    swipe(at("title"), [50, 100], [200, 100]);
    expect(f.drawer.open).toHaveBeenCalledTimes(1);
  });

  it("does not start while a panel is open", () => {
    const f = fixture();
    f.state.drawerOpen = true;
    swipe(at("title"), [50, 100], [200, 100]);
    f.state.drawerOpen = false;
    f.state.membersOpen = true;
    swipe(at("title"), [300, 100], [100, 100]);
    expect(f.drawer.open).not.toHaveBeenCalled();
    expect(f.panel.openOverlay).not.toHaveBeenCalled();
  });

  it("a vertical scroll opens nothing", () => {
    const f = fixture();
    swipe(at("title"), [100, 100], [130, 400]);
    expect(f.drawer.open).not.toHaveBeenCalled();
    expect(f.panel.openOverlay).not.toHaveBeenCalled();
  });

  it("never starts from the composer", () => {
    const f = fixture();
    swipe(at("composer"), [50, 100], [200, 100]);
    swipe(at("composer"), [300, 100], [100, 100]);
    expect(f.drawer.open).not.toHaveBeenCalled();
    expect(f.panel.openOverlay).not.toHaveBeenCalled();
  });

  it("an interrupted swipe opens nothing", () => {
    const f = fixture();
    pointer("pointerdown", at("title"), 50, 100);
    pointer("pointermove", at("title"), 200, 100);
    pointer("pointercancel", at("title"), 200, 100);
    expect(f.drawer.open).not.toHaveBeenCalled();
  });
});

describe("swipe to reply", () => {
  const row = (): HTMLElement => at("body5").closest(".message") as HTMLElement;

  it("the message follows the finger and a reply icon appears", () => {
    fixture();
    pointer("pointerdown", at("body5"), 300, 100);
    pointer("pointermove", at("body5"), 280, 101);
    expect(row().style.transform).toBe("translateX(-20px)");
    expect(row().classList.contains("msg-swiping")).toBe(true);
    const icon = document.querySelector<HTMLElement>('[data-testid="msg-swipe-reply"]')!;
    expect(icon).not.toBeNull();
    // Pinned to the frame around the list, not the scroller.
    expect(icon.parentElement?.classList.contains("messages-region")).toBe(true);
    expect(icon.classList.contains("armed")).toBe(false);
    pointer("pointerup", at("body5"), 280, 101);
  });

  it("stops following at the cap, and arms the icon at the threshold", () => {
    fixture();
    pointer("pointerdown", at("body5"), 300, 100);
    pointer("pointermove", at("body5"), 300 - REPLY_THRESHOLD_PX, 100);
    const icon = document.querySelector<HTMLElement>('[data-testid="msg-swipe-reply"]')!;
    expect(icon.classList.contains("armed")).toBe(true);
    pointer("pointermove", at("body5"), 300 - 150, 100);
    expect(row().style.transform).toBe(`translateX(-${REPLY_FOLLOW_MAX_PX}px)`);
    pointer("pointerup", at("body5"), 150, 100);
  });

  it("letting go past the threshold starts the reply as the Reply button does", () => {
    const f = fixture();
    swipe(at("body5"), [300, 100], [300 - REPLY_THRESHOLD_PX - 4, 102]);
    expect(f.reply).toHaveBeenCalledTimes(1);
    // The row eases back and the icon goes.
    expect(row().style.transform).toBe("");
    expect(row().classList.contains("msg-swiping")).toBe(false);
    expect(document.querySelector('[data-testid="msg-swipe-reply"]')).toBeNull();
  });

  it("letting go short of the threshold replies to nothing and snaps back", () => {
    const f = fixture();
    swipe(at("body5"), [300, 100], [300 - REPLY_THRESHOLD_PX + 8, 100]);
    expect(f.reply).not.toHaveBeenCalled();
    expect(row().style.transform).toBe("");
    expect(document.querySelector('[data-testid="msg-swipe-reply"]')).toBeNull();
  });

  it("a swipe that is interrupted past the threshold does not reply", () => {
    const f = fixture();
    pointer("pointerdown", at("body5"), 300, 100);
    pointer("pointermove", at("body5"), 200, 100);
    pointer("pointercancel", at("body5"), 200, 100);
    expect(f.reply).not.toHaveBeenCalled();
    expect(row().style.transform).toBe("");
  });

  it("does not reply when the row left the page before the lift", () => {
    const f = fixture();
    pointer("pointerdown", at("body5"), 300, 100);
    pointer("pointermove", at("body5"), 200, 100);
    row().remove();
    pointer("pointerup", at("chat"), 200, 100);
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("does not start from a sideways scroller inside the message", () => {
    const f = fixture();
    const code = document.createElement("pre");
    code.style.overflowX = "auto";
    Object.defineProperty(code, "scrollWidth", { value: 600, configurable: true });
    Object.defineProperty(code, "clientWidth", { value: 300, configurable: true });
    code.innerHTML = "<code id='code'>wide</code>";
    row().appendChild(code);
    swipe(at("code"), [300, 100], [100, 100]);
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.panel.openOverlay).not.toHaveBeenCalled();
    expect(row().style.transform).toBe("");
  });

  it("is a vertical scroll, not a reply, when the move is mostly up or down", () => {
    const f = fixture();
    swipe(at("body5"), [300, 100], [230, 190]);
    expect(f.reply).not.toHaveBeenCalled();
    expect(row().style.transform).toBe("");
  });
});

describe("closing a panel by swiping it away", () => {
  it("swiping the open drawer left closes it, from the sidebar or the rail", () => {
    const f = fixture();
    f.state.drawerOpen = true;
    swipe(at("channel"), [250, 100], [250 - PANEL_SWIPE_PX, 100]);
    expect(f.drawer.close).toHaveBeenCalledTimes(1);
    f.state.drawerOpen = true;
    swipe(at("server"), [60, 100], [0, 100]);
    expect(f.drawer.close).toHaveBeenCalledTimes(2);
  });

  it("a short or rightward swipe, or a closed drawer, does nothing", () => {
    const f = fixture();
    f.state.drawerOpen = true;
    swipe(at("channel"), [250, 100], [250 - PANEL_SWIPE_PX + 6, 100]);
    swipe(at("channel"), [100, 100], [250, 100]);
    f.state.drawerOpen = false;
    swipe(at("channel"), [250, 100], [100, 100]);
    expect(f.drawer.close).not.toHaveBeenCalled();
  });

  it("swiping the open member list right closes it, and left does nothing", () => {
    const f = fixture();
    f.state.membersOpen = true;
    swipe(at("who"), [100, 100], [100 - PANEL_SWIPE_PX, 100]);
    expect(f.panel.closeOverlay).not.toHaveBeenCalled();
    swipe(at("who"), [100, 100], [100 + PANEL_SWIPE_PX, 100]);
    expect(f.panel.closeOverlay).toHaveBeenCalledTimes(1);
  });

  it("a closed member list is not swiped shut, and nothing happens off the phone", () => {
    const f = fixture();
    swipe(at("who"), [100, 100], [300, 100]);
    f.state.membersOpen = true;
    f.state.drawerOpen = true;
    phone = false;
    swipe(at("who"), [100, 100], [300, 100]);
    swipe(at("channel"), [250, 100], [100, 100]);
    expect(f.panel.closeOverlay).not.toHaveBeenCalled();
    expect(f.drawer.close).not.toHaveBeenCalled();
  });
});
