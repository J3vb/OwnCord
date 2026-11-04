/**
 * U1(a): an OS notification must never leak raw markdown or spoiler-marked
 * text onto a lock screen. `markdownToPlainText` is the one serializer that
 * flattens a message to its visible words, and `notifyIncomingMessage` must
 * route the popup body through it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as mocks from "../helpers/notificationsMocks";
import { testPrefs } from "../helpers/notificationsMocks";
import { makePayload, seedGeneralChannel } from "../helpers/notificationsHarness";

import { markdownToPlainText } from "../../src/lib/text/markdown";
import { notifyIncomingMessage, resetNotificationCoalescing } from "../../src/lib/notifications";
import { dmStore } from "../../src/stores/dm.store";
import { signInAs } from "../helpers/storeSeeds";
import type { ChatMessagePayload } from "../../src/lib/types";

vi.mock("../../src/lib/prefs/preferences", (importOriginal) =>
  mocks.prefsPreferencesMock(importOriginal),
);
vi.mock("../../src/lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@tauri-apps/plugin-notification", () => mocks.pluginNotificationMock());

// The native path shows a message notification through the host's
// `notify_message` command (so a click can open it); this records the args.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

vi.mock("@tauri-apps/api/event", () => mocks.apiEventMock());
vi.mock("@tauri-apps/api/window", () => mocks.apiWindowMock());

describe("markdownToPlainText", () => {
  it("replaces a spoiler with a label and never leaks its hidden text", () => {
    const out = markdownToPlainText("the answer is ||forty-two|| ok", "Spoiler");
    expect(out).not.toContain("forty-two");
    expect(out).not.toContain("||");
    expect(out).toBe("the answer is Spoiler ok");
  });

  it("drops inline style markers but keeps the words", () => {
    expect(markdownToPlainText("**bold** *em* __under__ ~~strike~~", "Spoiler")).toBe(
      "bold em under strike",
    );
  });

  it("keeps code content without the backticks", () => {
    expect(markdownToPlainText("try `npm test` now", "Spoiler")).toBe("try npm test now");
  });

  it("shows a masked link's text, not its URL", () => {
    expect(markdownToPlainText("see [the docs](https://example.com/docs)", "Spoiler")).toBe(
      "see the docs",
    );
  });

  it("strips heading, quote and list block markers", () => {
    expect(markdownToPlainText("# Release notes", "Spoiler")).toBe("Release notes");
    expect(markdownToPlainText("> quoted line", "Spoiler")).toBe("quoted line");
    expect(markdownToPlainText("- one\n- two", "Spoiler")).toBe("one two");
  });

  it("strips a fenced code block's fences", () => {
    expect(markdownToPlainText("```js\nconst x = 1;\n```", "Spoiler")).toBe("const x = 1;");
  });

  it("collapses whitespace to a single line", () => {
    expect(markdownToPlainText("hello\n   world", "Spoiler")).toBe("hello world");
  });
});

describe("notifyIncomingMessage — popup body is plain text (U1a)", () => {
  beforeEach(() => {
    testPrefs.clear();
    resetNotificationCoalescing();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    signInAs(
      { id: 1, username: "Me", avatar: null, role: "member" },
      { token: "t", serverName: null },
    );
    seedGeneralChannel(null);
    dmStore.setState(() => ({ channels: [] }));
  });

  /** Sends one message from Bob with only the popup on, and waits for its popup body. */
  async function expectPopupBody(
    content: string,
    attachments: ChatMessagePayload["attachments"],
    body: string,
  ): Promise<void> {
    (invokeMock as ReturnType<typeof vi.fn>).mockClear();
    testPrefs.set("desktopNotifications", true);
    testPrefs.set("flashTaskbar", false);
    testPrefs.set("notificationSounds", false);
    // These cases are about the body, not the level gate; use All so a
    // non-mention message still fires.
    testPrefs.set("notificationLevel", "all");

    notifyIncomingMessage(
      makePayload({ user: { id: 2, username: "Bob", avatar: null }, content, attachments }),
    );

    await vi.waitFor(() => {
      const call = invokeMock.mock.calls.find((c) => c[0] === "notify_message")![1] as {
        body: string;
      };
      expect(call.body).toBe(body);
    });
  }

  it("strips spoilers and markdown from the body", async () => {
    await expectPopupBody("**hi** ||secret|| there", [], "hi Spoiler there");
  });

  it("an empty-content message with 2 attachments has the body 'sent 2 attachments'", async () => {
    await expectPopupBody(
      "",
      [
        { id: "a1", filename: "a.png", size: 1, mime: "image/png", url: "/a.png" },
        { id: "a2", filename: "b.png", size: 1, mime: "image/png", url: "/b.png" },
      ],
      "sent 2 attachments",
    );
  });

  it("an empty-content message with 1 attachment has the body 'sent an attachment'", async () => {
    await expectPopupBody(
      "",
      [{ id: "a1", filename: "a.png", size: 1, mime: "image/png", url: "/a.png" }],
      "sent an attachment",
    );
  });
});
