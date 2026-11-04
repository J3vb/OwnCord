import { describe, it, expect, vi, beforeEach } from "vitest";

// Spy on the media-visibility manager: MessageList must release every tracked
// <img> (discardMedia) before discarding rendered rows, otherwise the
// IntersectionObserver + allTracked set + pending timers retain every GIF
// ever rendered.
// B9-8: this suite exercises content the viewer has already consented to;
// the consent gate itself is proven in src/features/content-consent/external.test.ts.
import * as mocks from "../helpers/messageListMocks";
vi.mock("../../src/features/content-consent/external", (importOriginal) =>
  mocks.consentedExternalMock(importOriginal),
);

// No native host: the GIF stays loading, so the suite sees only the observer.
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => new Promise(() => {}) }));

vi.mock("@lib/prefs/mediaVisibility", () => mocks.mediaVisibilityMock());

import { createMessageList } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import { makeMessage, useMessageListHarness, setMessages } from "../helpers/messageListHarness";
import "../helpers/resizeObserverStub";

const { observeMediaMock, discardMediaMock } = mocks;

describe("MessageList media release (GIF observer leak fix)", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList>;

  useMessageListHarness(
    (wired) => {
      container = wired.container;
      msgList = wired.msgList;
    },
    () => msgList,
  );

  beforeEach(() => {
    observeMediaMock.mockClear();
    discardMediaMock.mockClear();
  });

  it("unobserves rendered <img> elements before a full re-render discards them", () => {
    const later = makeMessage({ id: 3, content: "later", timestamp: "2024-01-15T12:01:00Z" });
    setMessages(1, [makeMessage({ id: 2, content: "look https://example.com/anim.gif" }), later]);
    msgList.mount(container);

    const img = container.querySelector(".virtual-content img");
    expect(img).not.toBeNull();
    discardMediaMock.mockClear();

    // Reorder the rows — the row patch leaves a reorder to the full-rebuild
    // path that tears the rendered rows down.
    setMessages(1, [later, makeMessage({ id: 2, content: "look https://example.com/anim.gif" })]);
    messagesStore.flush();

    expect(discardMediaMock).toHaveBeenCalledWith(img);
  });

  it("unobserves rendered <img> elements on destroy", () => {
    setMessages(1, [makeMessage({ id: 1, content: "look https://example.com/anim.gif" })]);
    msgList.mount(container);

    const img = container.querySelector(".virtual-content img");
    expect(img).not.toBeNull();
    discardMediaMock.mockClear();

    msgList.destroy?.();

    expect(discardMediaMock).toHaveBeenCalledWith(img);
  });

  it("does not unobserve retained rows on the incremental append fast path", () => {
    const gifMessage = makeMessage({ id: 1, content: "look https://example.com/anim.gif" });
    setMessages(1, [gifMessage]);
    msgList.mount(container);
    expect(container.querySelector(".virtual-content img")).not.toBeNull();
    discardMediaMock.mockClear();

    // Suffix extension (same leading references) → rows are kept, so nothing
    // must be released.
    setMessages(1, [
      gifMessage,
      makeMessage({ id: 2, content: "plain follow-up", timestamp: "2024-01-15T12:01:00Z" }),
    ]);
    messagesStore.flush();

    expect(discardMediaMock).not.toHaveBeenCalled();
  });
});
