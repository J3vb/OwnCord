import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/messageListMocks";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import type { Message } from "@stores/messages.store";
import {
  resetSafetyStore,
  safetyStore,
  setActiveTimeout,
} from "../../../src/features/safety/store";
import { setConnectionStatus, uiStore } from "../../../src/stores/ui.store";
import { expectConsole } from "../../helpers/console";
import {
  makeMessage,
  setMessages,
  setHasMore,
  setHistoryLoadState,
  MessageListComponent,
  useMessageListHarness,
} from "../../helpers/messageListHarness";

vi.mock("../../../src/components/message-list/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);

const { fetchImageAsObjectUrlMock } = mocks;

describe("MessageList", () => {
  let container: HTMLDivElement;
  let msgList: MessageListComponent;
  let options: MessageListOptions;

  useMessageListHarness(
    (wired) => {
      container = wired.container;
      options = wired.options;
      msgList = wired.msgList;
    },
    () => msgList,
  );

  // DP-10: revisiting a channel shows its cached rows while the tail is
  // refetched; the fetch finishing must not rebuild them.
  describe("channel revisit", () => {
    it("does not rebuild shown rows when the history fetch goes from loading to idle", () => {
      setMessages(1, [
        makeMessage({ id: 1, content: "First" }),
        makeMessage({ id: 2, content: "Second", timestamp: "2024-01-15T12:01:00Z" }),
      ]);
      setHistoryLoadState(1, "loading");
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      expect(row1).not.toBeNull();

      messagesStore.setState((prev) => ({ ...prev, historyLoadState: new Map() }));
      messagesStore.flush();

      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
    });

    it("still swaps the loading placeholder when no rows are shown", () => {
      setHistoryLoadState(1, "loading");
      msgList.mount(container);
      expect(container.querySelector(".messages-loading")).not.toBeNull();

      setHistoryLoadState(1, "error");
      messagesStore.flush();

      expect(container.querySelector(".messages-loading")).toBeNull();
    });
  });

  // P4-02: an append at the 500-row cap, a connection flip, a timeout change
  // and a role change must not rebuild the rendered rows. The cap append goes
  // through P4-01's row patch; the three flips are targeted updates.
  describe("targeted updates", () => {
    const current = (): readonly Message[] => messagesStore.getState().messagesByChannel.get(1)!;

    it("appends at the 500-row cap without rebuilding the rows that stay", () => {
      const full = Array.from({ length: 500 }, (_, i) =>
        makeMessage({
          id: i + 1,
          timestamp: new Date(Date.UTC(2024, 0, 15, 0, 0, i)).toISOString(),
        }),
      );
      setMessages(1, full);
      msgList.mount(container);

      const row498 = container.querySelector("[data-testid='message-498']");
      const row500 = container.querySelector("[data-testid='message-500']");
      expect(row498).not.toBeNull();
      expect(row500).not.toBeNull();

      // The live reducer trims the head to stay at the cap; the array length is
      // unchanged, which used to defeat the append path and force renderAll.
      messagesStore.setState((prev) => {
        const next = [...current(), makeMessage({ id: 501, timestamp: "2024-01-15T01:00:00Z" })];
        const trimmed = next.slice(next.length - 500);
        const m = new Map(prev.messagesByChannel);
        m.set(1, trimmed);
        return { ...prev, messagesByChannel: m };
      });
      messagesStore.flush();

      expect(container.querySelector("[data-testid='message-498']")).toBe(row498);
      expect(container.querySelector("[data-testid='message-500']")).toBe(row500);
      expect(container.querySelector("[data-testid='message-501']")).not.toBeNull();
    });

    it("keeps row identity through a connection flip and still gates delete", () => {
      setConnectionStatus("connected");
      uiStore.flush();
      setMessages(1, [makeMessage({ id: 1 }), makeMessage({ id: 2 })]);
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      const deleteBtn = (): HTMLButtonElement =>
        container.querySelector<HTMLButtonElement>("[data-testid='msg-delete-1']")!;
      expect(deleteBtn().disabled).toBe(false);

      setConnectionStatus("disconnected");
      uiStore.flush();
      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      expect(deleteBtn().disabled).toBe(true);
      expect(deleteBtn().getAttribute("aria-disabled")).toBe("true");

      setConnectionStatus("connected");
      uiStore.flush();
      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      deleteBtn().click();
      expect(options.onDeleteClick).toHaveBeenCalledWith(1, false);
    });

    it("disables reaction controls while timed out without rebuilding rows", () => {
      setConnectionStatus("connected");
      uiStore.flush();
      setMessages(1, [makeMessage({ id: 1, reactions: [{ emoji: "🔥", count: 2, me: false }] })]);
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      const chip = (): HTMLElement =>
        container.querySelector<HTMLElement>("[data-testid='message-1'] .reaction-chip")!;
      expect(chip().getAttribute("aria-disabled")).not.toBe("true");

      setActiveTimeout(new Date(Date.now() + 60_000).toISOString());
      safetyStore.flush();
      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      expect(chip().getAttribute("aria-disabled")).toBe("true");
      chip().click();
      expect(options.onReactionClick).not.toHaveBeenCalled();

      setActiveTimeout(null);
      safetyStore.flush();
      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      expect(chip().hasAttribute("aria-disabled")).toBe(false);
      chip().click();
      expect(options.onReactionClick).toHaveBeenCalledWith(1, "🔥");
      resetSafetyStore();
    });

    it("repaints author identity on a roleRevision bump without rebuilding rows", () => {
      membersStore.setState(() => ({
        members: new Map([
          [
            1,
            { id: 1, username: "Alice", avatar: null, role: "member", status: "online" as const },
          ],
        ]),
        typingUsers: new Map(),
        roleRevision: 0,
      }));
      setMessages(1, [makeMessage({ id: 1 }), makeMessage({ id: 2 })]);
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      const authorSpan = (): HTMLElement =>
        container.querySelector<HTMLElement>("[data-testid='message-1'] .msg-author")!;
      expect(authorSpan().dataset["roleColor"]).toBe("var(--role-member)");
      expect(authorSpan().textContent).toBe("Alice");

      // A role change bumps roleRevision; a rename bumps it too (OC-0108).
      membersStore.setState((prev) => {
        const next = new Map(prev.members);
        next.set(1, { ...next.get(1)!, role: "admin", username: "Alicia" });
        return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
      });
      membersStore.flush();

      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      expect(authorSpan().dataset["roleColor"]).toBe("var(--role-admin)");
      expect(authorSpan().textContent).toBe("Alicia");
    });

    it("re-resolves @mention highlighting on every rendered row on a rename (F3)", () => {
      authStore.setState(() => ({
        token: "t",
        user: { id: 99, username: "me", avatar: null, role: "member" },
        serverName: null,
        motd: null,
        isAuthenticated: true,
      }));
      membersStore.setState(() => ({
        members: new Map([
          [
            10,
            {
              id: 10,
              username: "alice",
              avatar: null,
              role: "member",
              status: "online" as const,
            },
          ],
        ]),
        typingUsers: new Map(),
        roleRevision: 0,
      }));
      // Row 1 is authored by alice; row 2 mentions alice but is authored by Bob,
      // so the pill lives on a row that member did not author.
      setMessages(1, [
        makeMessage({ id: 1, user: { id: 10, username: "alice", avatar: null } }),
        makeMessage({
          id: 2,
          user: { id: 2, username: "Bob", avatar: null },
          content: "hey @alice",
        }),
      ]);
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      const row2 = container.querySelector("[data-testid='message-2']");
      expect(container.querySelector("[data-testid='message-2'] .mention")?.textContent).toBe(
        "@alice",
      );

      membersStore.setState((prev) => {
        const next = new Map(prev.members);
        next.set(10, { ...next.get(10)!, username: "alicia" });
        return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
      });
      membersStore.flush();

      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      expect(container.querySelector("[data-testid='message-2']")).toBe(row2);
      expect(container.querySelector("[data-testid='message-2'] .mention")).toBeNull();
      expect(row2!.querySelector(".msg-text")!.textContent).toBe("hey @alice");
    });

    it("wraps every newly-resolving @token across sibling prose nodes on a member join (F3)", () => {
      authStore.setState(() => ({
        token: "t",
        user: { id: 99, username: "me", avatar: null, role: "member" },
        serverName: null,
        motd: null,
        isAuthenticated: true,
      }));
      membersStore.setState(() => ({
        members: new Map([
          [2, { id: 2, username: "Bob", avatar: null, role: "member", status: "online" as const }],
        ]),
        typingUsers: new Map(),
        roleRevision: 0,
      }));
      setMessages(1, [
        makeMessage({
          id: 1,
          user: { id: 2, username: "Bob", avatar: null },
          content: "check @alice and **@carol** and [@dave](https://example.com)",
        }),
      ]);
      msgList.mount(container);
      const row = container.querySelector("[data-testid='message-1']")!;
      expect(row.querySelectorAll(".mention").length).toBe(0);

      // alice, carol and dave all become resolvable at once via a join.
      membersStore.setState((prev) => {
        const next = new Map(prev.members);
        next.set(10, {
          id: 10,
          username: "alice",
          avatar: null,
          role: "member",
          status: "online" as const,
        });
        next.set(11, {
          id: 11,
          username: "carol",
          avatar: null,
          role: "member",
          status: "online" as const,
        });
        next.set(12, {
          id: 12,
          username: "dave",
          avatar: null,
          role: "member",
          status: "online" as const,
        });
        return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
      });
      membersStore.flush();

      const text = row.querySelector(".msg-text")!;
      const mentions = [...text.querySelectorAll(".mention")].map((m) => m.textContent);
      expect(mentions).toContain("@alice");
      expect(mentions).toContain("@carol");
      expect(mentions).toContain("@dave");
      expect(text.querySelector("a.msg-link .mention")?.textContent).toBe("@dave");
      // The prose keeps its full text; only the tokens became pills.
      expect(text.textContent).toBe("check @alice and @carol and @dave");
    });

    it("does not promote an @token inside a rejected masked link to a pill (F3)", () => {
      authStore.setState(() => ({
        token: "t",
        user: { id: 99, username: "me", avatar: null, role: "member" },
        serverName: null,
        motd: null,
        isAuthenticated: true,
      }));
      membersStore.setState(() => ({
        members: new Map([
          [2, { id: 2, username: "Bob", avatar: null, role: "member", status: "online" as const }],
        ]),
        typingUsers: new Map(),
        roleRevision: 0,
      }));
      setMessages(1, [
        makeMessage({
          id: 1,
          user: { id: 2, username: "Bob", avatar: null },
          content: "[@dave](/settings)",
        }),
      ]);
      msgList.mount(container);
      const row = container.querySelector("[data-testid='message-1']")!;
      // The relative URL is rejected, so the source renders literally and no
      // mention is highlighted at render time — nor must the resync add one.
      expect(row.querySelector(".mention")).toBeNull();

      membersStore.setState((prev) => {
        const next = new Map(prev.members);
        next.set(12, {
          id: 12,
          username: "dave",
          avatar: null,
          role: "member",
          status: "online" as const,
        });
        return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
      });
      membersStore.flush();

      expect(row.querySelector(".mention")).toBeNull();
      expect(row.querySelector(".msg-text")!.textContent).toBe("[@dave](/settings)");
    });

    it("does not promote an @token inside a rejected bare URL to a pill (F3)", () => {
      authStore.setState(() => ({
        token: "t",
        user: { id: 99, username: "me", avatar: null, role: "member" },
        serverName: null,
        motd: null,
        isAuthenticated: true,
      }));
      membersStore.setState(() => ({
        members: new Map([
          [2, { id: 2, username: "Bob", avatar: null, role: "member", status: "online" as const }],
        ]),
        typingUsers: new Map(),
        roleRevision: 0,
      }));
      setMessages(1, [
        makeMessage({
          id: 1,
          user: { id: 2, username: "Bob", avatar: null },
          content: "see https://[/@dave",
        }),
      ]);
      msgList.mount(container);
      const row = container.querySelector("[data-testid='message-1']")!;
      // An unparseable URL is left as raw text and never linkified, so its
      // @token is not highlighted at render time — nor must the resync add one.
      expect(row.querySelector("a.msg-link")).toBeNull();
      expect(row.querySelector(".mention")).toBeNull();

      membersStore.setState((prev) => {
        const next = new Map(prev.members);
        next.set(12, {
          id: 12,
          username: "dave",
          avatar: null,
          role: "member",
          status: "online" as const,
        });
        return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
      });
      membersStore.flush();

      expect(row.querySelector(".mention")).toBeNull();
      expect(row.querySelector(".msg-text")!.textContent).toBe("see https://[/@dave");
    });

    it("updates the author's hover handle when only the username changes behind a display name (F3)", () => {
      membersStore.setState(() => ({
        members: new Map([
          [
            1,
            {
              id: 1,
              username: "alice",
              avatar: null,
              role: "member",
              status: "online" as const,
              displayName: "Ali",
            },
          ],
        ]),
        typingUsers: new Map(),
        roleRevision: 0,
      }));
      setMessages(1, [makeMessage({ id: 1 })]);
      msgList.mount(container);
      const authorEl = (): HTMLElement =>
        container.querySelector<HTMLElement>("[data-testid='message-1'] .msg-author")!;
      expect(authorEl().textContent).toBe("Ali");
      expect(authorEl().title).toBe("alice");

      // Only the username changes; the displayed name ("Ali") and avatar stay
      // put, so the repaint key must still move for the title to track it.
      membersStore.setState((prev) => {
        const next = new Map(prev.members);
        next.set(1, { ...next.get(1)!, username: "alicia" });
        return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
      });
      membersStore.flush();

      expect(authorEl().textContent).toBe("Ali");
      expect(authorEl().title).toBe("alicia");
    });

    it("repaints a reply's quoted author on a rename without rebuilding either row", () => {
      membersStore.setState(() => ({
        members: new Map([
          [
            1,
            { id: 1, username: "Alice", avatar: null, role: "member", status: "online" as const },
          ],
        ]),
        typingUsers: new Map(),
        roleRevision: 0,
      }));
      // Row 2 replies to row 1; row 2's own author (id 2) never changes.
      setMessages(1, [
        makeMessage({ id: 1 }),
        makeMessage({
          id: 2,
          user: { id: 2, username: "Bob", avatar: null },
          replyTo: 1,
        }),
      ]);
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      const row2 = container.querySelector("[data-testid='message-2']");
      const rrAuthor = (): HTMLElement =>
        container.querySelector<HTMLElement>("[data-testid='message-2'] .rr-author")!;
      expect(rrAuthor().textContent).toBe("Alice");

      membersStore.setState((prev) => {
        const next = new Map(prev.members);
        next.set(1, { ...next.get(1)!, username: "Alicia" });
        return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
      });
      membersStore.flush();

      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      expect(container.querySelector("[data-testid='message-2']")).toBe(row2);
      expect(rrAuthor().textContent).toBe("Alicia");
    });

    it("refetches an author's avatar on an avatar-only profile change", async () => {
      membersStore.setState(() => ({
        members: new Map([
          [
            1,
            {
              id: 1,
              username: "Alice",
              avatar: "/api/v1/files/old",
              role: "member",
              status: "online" as const,
            },
          ],
        ]),
        typingUsers: new Map(),
        roleRevision: 0,
      }));
      fetchImageAsObjectUrlMock.mockClear();
      setMessages(1, [makeMessage({ id: 1 }), makeMessage({ id: 2 })]);
      msgList.mount(container);
      const row1 = container.querySelector("[data-testid='message-1']");
      // The initial row's own avatar fetch, then the change below.
      await vi.waitFor(() => {
        expect(fetchImageAsObjectUrlMock).toHaveBeenCalledWith("/api/v1/files/old");
      });
      fetchImageAsObjectUrlMock.mockClear();

      // Only the avatar changes; username and role stay put. The author key
      // includes the avatar URL, so the row must rebuild and refetch, not just
      // repaint the letter fallback.
      membersStore.setState((prev) => {
        const next = new Map(prev.members);
        next.set(1, { ...next.get(1)!, avatar: "/api/v1/files/new" });
        return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
      });
      membersStore.flush();

      expect(container.querySelector("[data-testid='message-1']")).toBe(row1);
      const rowAvatar = row1!.querySelector<HTMLElement>(".msg-avatar")!;
      await vi.waitFor(() => {
        expect(rowAvatar.querySelector<HTMLImageElement>(".avatar-img")?.getAttribute("src")).toBe(
          "data:image/png;base64,AAAA",
        );
      });
      expect(fetchImageAsObjectUrlMock).toHaveBeenCalledWith("/api/v1/files/new");
    });
  });

  describe("renderAll rapid-fire breaker", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("renders the final state once the 2s burst window resets, instead of staying stuck at the pre-trip state", () => {
      const others = Array.from({ length: 25 }, (_, i) => makeMessage({ id: i + 2 }));
      setMessages(1, [makeMessage({ id: 1, content: "v0" }), ...others]);
      msgList.mount(container); // 1st renderAll call, starts the 2s window

      // Fire 25 updates back-to-back, well inside the 2s window, each editing
      // message 1 and moving it one row further down. Every update is then a
      // reorder against any earlier state, the last one rendered before the
      // breaker trips included, and the row patch leaves a reorder to
      // renderAll. Combined with the mount's call, this is 26 renderAll
      // invocations — calls 21+ trip the >20-in-2s breaker and must return
      // without rendering.
      for (let i = 1; i <= 25; i++) {
        setMessages(1, others.toSpliced(i, 0, makeMessage({ id: 1, content: `v${i}` })));
        messagesStore.flush();
      }
      expectConsole("error", /\[MessageList\] renderAll called >20 times in 2s/);
      expectConsole("error", /\[MessageList\] renderAll called >20 times in 2s/);
      expectConsole("error", /\[MessageList\] renderAll called >20 times in 2s/);
      expectConsole("error", /\[MessageList\] renderAll called >20 times in 2s/);
      expectConsole("error", /\[MessageList\] renderAll called >20 times in 2s/);
      expectConsole("error", /\[MessageList\] renderAll called >20 times in 2s/);

      const rowDuringBurst = container.querySelector("[data-testid='message-1']");
      expect(rowDuringBurst).not.toBeNull();
      // The breaker tripped partway through, so the DOM is stuck behind the
      // final store state (still showing an earlier version, not "v25").
      expect(rowDuringBurst!.textContent).not.toContain("v25");

      // Let the 2s reset window elapse with no further store updates.
      vi.advanceTimersByTime(2100);

      // Once the burst is over, the list must reflect the final state that
      // triggered the last suppressed renderAll — not stay frozen on
      // whatever rendered right before the breaker tripped.
      const rowAfterReset = container.querySelector("[data-testid='message-1']");
      expect(rowAfterReset).not.toBeNull();
      expect(rowAfterReset!.textContent).toContain("v25");
    });
  });

  describe("renderWindow rebuild breaker replay", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it(
      "renders the rows for the final scrollTop once the 2s burst resets",
      { timeout: 20_000 },
      () => {
        setHasMore(1, false);
        setMessages(
          1,
          Array.from({ length: 300 }, (_, i) => makeMessage({ id: i + 1 })),
        );
        msgList.mount(container); // rebuild 1
        const root = container.querySelector(".messages-container") as HTMLDivElement;

        // A fast scrollbar drag: every frame lands somewhere the window has not
        // rendered, so each one is a range-changing rebuild. 34 of them inside
        // 2s trip the >30 breaker.
        for (let i = 0; i < 34; i++) {
          root.scrollTop = i % 2 === 0 ? 0 : 6000;
          root.dispatchEvent(new Event("scroll"));
          vi.advanceTimersByTime(16);
        }
        // The drag stops mid-channel (message 134 sits at about 3000px).
        root.scrollTop = 3000;
        root.dispatchEvent(new Event("scroll"));
        vi.advanceTimersByTime(16);
        expectConsole("error", /\[MessageList\] renderWindow REBUILD called >30 times in 2s/);
        expect(container.querySelector('[data-testid="message-134"]')).toBeNull();

        // Idle past the reset: the deferred replay renders where the reader stopped.
        vi.advanceTimersByTime(2100);
        expect(container.querySelector('[data-testid="message-134"]')).not.toBeNull();
      },
    );
  });

  describe("midnight rollover", () => {
    it("relabels 'Today at' to 'Yesterday at' at midnight without a channel switch", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(2024, 0, 15, 12, 0, 0));
        const msg = makeMessage({ id: 1, timestamp: new Date().toISOString() });
        setMessages(1, [msg]);
        msgList.mount(container);

        const row = container.querySelector('[data-testid="message-1"]');
        expect(container.querySelector(".msg-time")!.textContent).toMatch(/^Today at /);

        // Cross local midnight (00:00 on the 16th) on the same channel.
        vi.advanceTimersByTime(13 * 60 * 60 * 1000);

        expect(container.querySelector(".msg-time")!.textContent).toMatch(/^Yesterday at /);
        expect(container.querySelector('[data-testid="message-1"]')).toBe(row);
      } finally {
        vi.useRealTimers();
      }
    });

    it("releases the midnight timer on destroy", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(2024, 0, 15, 12, 0, 0));
        setMessages(1, [makeMessage({ id: 1, timestamp: new Date().toISOString() })]);
        const pendingBeforeMount = vi.getTimerCount();
        msgList.mount(container);
        expect(vi.getTimerCount()).toBeGreaterThan(pendingBeforeMount);

        msgList.destroy?.();

        expect(vi.getTimerCount()).toBe(pendingBeforeMount);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("scrollToMessage vs renderWindow rebuild breaker", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // 30 synchronous full renderWindow rebuilds of a 100-row list can exceed
    // vitest's default 5s on a loaded CI runner (audit-2026-08-19 F-5), so
    // this test carries its own timeout.
    it(
      "does not report success when renderWindow's own >30-in-2s breaker drops the rebuild",
      { timeout: 20_000 },
      () => {
        const many = Array.from({ length: 100 }, (_, i) => makeMessage({ id: i + 1 }));
        setMessages(1, many);
        msgList.mount(container); // mount's renderAll -> renderWindow: rebuild count = 1

        // Every scrollToMessage call forces renderedStart = -1 and calls
        // renderWindow() directly, bypassing renderAll's own (lower) rapid-fire
        // limit. 29 more calls bring the shared renderWindow rebuild counter to
        // 30 (still under the >30 breaker), each one landing normally.
        for (let i = 0; i < 29; i++) {
          expect(msgList.scrollToMessage(i + 1)).toBe(true);
        }

        // The 30th call pushes the counter to 31 and trips the breaker inside
        // renderWindow: it returns before reassigning renderedStart/renderedEnd
        // or touching the DOM, so the target (far outside the last rendered
        // window) never actually renders.
        const result = msgList.scrollToMessage(90);
        expectConsole("error", /\[MessageList\] renderWindow REBUILD called >30 times in 2s/);

        // The rebuild did not happen — the row is not in the DOM — so this must
        // be reported as a failed jump (matching the "false if the message is
        // not in the loaded window" contract), not a false "true".
        expect(container.querySelector('[data-testid="message-90"]')).toBeNull();
        expect(result).toBe(false);
      },
    );
  });
});
