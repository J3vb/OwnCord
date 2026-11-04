// OC-0156: createPresenceSender's send() clears any pending retry and
// re-arms it carrying only its own `customStatus` argument. A plain status
// change (customStatus === undefined) landing while a custom-status commit
// is still queued behind the shared limiter must not erase the queued
// custom_status — the retry must still carry the last customStatus the user
// committed.
import { describe, it, expect, vi } from "vitest";
import { authStore } from "@stores/auth.store";
import { membersStore, updatePresence } from "@stores/members.store";
import { createPresenceSender } from "@lib/presence/presence";
import { createPresenceLimiter, type RateLimiter } from "@lib/net/rateLimiter";
import {
  loadCustomStatus,
  loadUserStatus,
  loadUserStatusOrigin,
  saveCustomStatus,
  saveUserStatus,
} from "@lib/presence/userStatus";
import { createMockWs, usePresenceFixture, withSender } from "../helpers/presenceSenderHarness";

describe("createPresenceSender — last requested status always reaches the server", () => {
  usePresenceFixture(undefined);

  it("re-arms the retry when the queued frame is answered RATE_LIMITED, so the latest status still lands", () => {
    withSender({ fakeTimers: true }, ({ sender, sent, fireError }) => {
      // t=0s: "dnd" consumes the shared limiter's only token.
      saveUserStatus("dnd");
      sender.send("dnd");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.payload.status).toBe("dnd");

      // t=0s: a second change is queued behind the closed window.
      saveUserStatus("invisible");
      sender.send("invisible");
      expect(sent).toHaveLength(1);

      // t=11s: the retry fires (10s client window + the OC-0451 margin). The
      // server, whose window started when it received the first frame a few
      // ms later, still refuses it — RATE_LIMITED on the retry's own id.
      vi.advanceTimersByTime(11_000);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.payload.status).toBe("invisible");
      fireError("RATE_LIMITED", "id-2");

      // The rejection must schedule another retry a full window out instead
      // of dropping the change: the client would otherwise show and save
      // "invisible" while the server (and everyone else) kept "dnd".
      vi.advanceTimersByTime(11_000);
      expect(sent).toHaveLength(3);
      expect(sent[2]!.payload.status).toBe("invisible");
    });
  });

  it("does not re-arm for a RATE_LIMITED reply to another producer's frame", () => {
    withSender({ fakeTimers: true }, ({ sender, sent, fireError }) => {
      saveUserStatus("dnd");
      sender.send("dnd");
      expect(sent).toHaveLength(1);

      // An unrelated frame's rejection (a chat send, or a second limiter the
      // server refused) must not make this sender spam presence updates.
      fireError("RATE_LIMITED", "some-other-id");
      vi.advanceTimersByTime(30_000);
      expect(sent).toHaveLength(1);
    });
  });
});

describe("createPresenceSender — a TIMED_OUT refusal rolls back the optimistic status", () => {
  usePresenceFixture("old text");

  // The server broadcasts nothing when it refuses a timed-out custom status
  // (service/channel.go's requireNotTimedOut), so the optimistic apply in
  // send() and UserBar's saveCustomStatus would leave the user seeing a status
  // nobody else has. The dispatcher's error chain calls rollbackRefused for a
  // TIMED_OUT frame; this pins the sender half.
  it("restores the previous member status/text and the saved prefs for our own frame", () => {
    withSender({}, ({ sender, sent }) => {
      // The status the server already knows, mirrored into the prefs.
      saveUserStatus("online");
      saveCustomStatus("old text");

      // UserBar's onCustomStatusChange: persist the new text, then send.
      saveCustomStatus("new text");
      sender.send("dnd", "new text");

      expect(sent).toHaveLength(1);
      expect(sent[0]!.payload.status).toBe("dnd");
      expect(sent[0]!.payload.custom_status).toBe("new text");
      // Optimistic apply already moved the local copies.
      expect(membersStore.getState().members.get(1)?.status).toBe("dnd");
      expect(membersStore.getState().members.get(1)?.customStatus).toBe("new text");
      expect(loadCustomStatus()).toBe("new text");

      sender.rollbackRefused("id-1");

      // In memory (membersStore) and in what was saved (the prefs).
      expect(membersStore.getState().members.get(1)?.status).toBe("online");
      expect(membersStore.getState().members.get(1)?.customStatus).toBe("old text");
      expect(loadUserStatus()).toBe("online");
      expect(loadCustomStatus()).toBe("old text");
    });
  });

  it("ignores a TIMED_OUT refusal of another producer's frame or an unknown id", () => {
    withSender({}, ({ sender, sent }) => {
      saveUserStatus("online");
      saveCustomStatus("old text");
      saveCustomStatus("new text");
      sender.send("dnd", "new text");
      expect(sent).toHaveLength(1);

      sender.rollbackRefused("some-other-id");
      sender.rollbackRefused(undefined);

      expect(membersStore.getState().members.get(1)?.customStatus).toBe("new text");
      expect(loadCustomStatus()).toBe("new text");
    });
  });

  it("does not arm a retry for a refused frame (a timeout is not transient)", () => {
    withSender({ fakeTimers: true }, ({ sender, sent }) => {
      saveUserStatus("online");
      saveCustomStatus("old text");
      saveCustomStatus("new text");
      sender.send("dnd", "new text");
      sender.rollbackRefused("id-1");
      vi.advanceTimersByTime(60_000);
      expect(sent).toHaveLength(1);
    });
  });

  it("keeps the pre-send status as the rollback target when a second edit queues behind the limiter", () => {
    withSender({ fakeTimers: true }, ({ sender, sent }) => {
      saveUserStatus("online");
      saveCustomStatus("hi");
      sender.send("online", "hi");
      expect(sent).toHaveLength(1);

      saveCustomStatus("yo");
      sender.send("online", "yo");
      expect(sent).toHaveLength(1);

      // The first frame's refusal must not roll back over the queued edit.
      sender.rollbackRefused("id-1");
      expect(membersStore.getState().members.get(1)?.customStatus).toBe("yo");
      expect(loadCustomStatus()).toBe("yo");

      vi.advanceTimersByTime(60_000);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.payload.custom_status).toBe("yo");

      // The queued frame is refused too: back to what the server really has,
      // not the first, also refused, text.
      sender.rollbackRefused("id-2");
      expect(membersStore.getState().members.get(1)?.customStatus).toBe("old text");
      expect(loadCustomStatus()).toBe("old text");
    });
  });

  it("drops the refused text but keeps the picked status when a plain flip queues behind it", () => {
    withSender({ fakeTimers: true }, ({ sender, sent }) => {
      saveUserStatus("online");
      saveCustomStatus("hi");
      sender.send("online", "hi");

      saveUserStatus("dnd");
      sender.send("dnd");
      expect(sent).toHaveLength(1);

      sender.rollbackRefused("id-1");
      expect(membersStore.getState().members.get(1)?.customStatus).toBe("old text");
      expect(membersStore.getState().members.get(1)?.status).toBe("dnd");
      expect(authStore.getState().user?.custom_status).toBe("old text");
      expect(loadCustomStatus()).toBe("old text");
      expect(loadUserStatus()).toBe("dnd");

      vi.advanceTimersByTime(60_000);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.payload.status).toBe("dnd");
    });
  });
});

describe("createPresenceSender — custom_status survival across supersession", () => {
  usePresenceFixture(undefined);

  it("does not drop a queued custom_status when a later plain status change supersedes it before the retry fires", () => {
    vi.useFakeTimers();
    const ws = createMockWs();
    const sender = createPresenceSender(ws, createPresenceLimiter());
    try {
      // t=0s: plain status change consumes the shared limiter's only token.
      // Mirrors UserBar.ts's onStatusChange, which persists the picked
      // status before calling sender.send(status) — the queued retry's
      // `loadUserStatus()` re-read depends on that.
      saveUserStatus("idle");
      sender.send("idle");
      expect(ws.send).toHaveBeenCalledOnce();
      expect((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual({
        type: "presence_update",
        payload: { status: "idle" },
      });
      (ws.send as ReturnType<typeof vi.fn>).mockClear();

      // t=2s: custom-status commit — window still closed, so it queues a
      // retry carrying "Working on OwnCord".
      vi.advanceTimersByTime(2_000);
      sender.send("idle", "Working on OwnCord");
      expect(ws.send).not.toHaveBeenCalled();

      // t=4s: a plain status change (customStatus === undefined) supersedes
      // the queued retry. Mirrors UserBar.ts's onStatusChange again.
      vi.advanceTimersByTime(2_000);
      saveUserStatus("dnd");
      sender.send("dnd");
      expect(ws.send).not.toHaveBeenCalled();

      // t=11s: the coalesced retry fires (10s client window + the OC-0451
      // margin that clears the server's receipt-measured window). It must
      // still carry the custom_status text committed at t=2s — the plain
      // "dnd" call at t=4s never mentioned custom_status and must not be
      // read as "clear it".
      vi.advanceTimersByTime(7_000);

      expect(ws.send).toHaveBeenCalledOnce();
      const sentMsg = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(sentMsg.type).toBe("presence_update");
      expect(sentMsg.payload.status).toBe("dnd");
      expect(sentMsg.payload.custom_status).toBe("Working on OwnCord");
    } finally {
      sender.destroy?.();
    }
  });
});

describe("createPresenceSender — rollback, retry and teardown details", () => {
  const member = (): { status?: string; customStatus?: string | null } | undefined =>
    membersStore.getState().members.get(1);

  usePresenceFixture("old text");

  it("rolls back a refused status flip that carried no text", () => {
    withSender({}, ({ sender }) => {
      saveUserStatus("online");
      saveUserStatus("dnd");
      sender.send("dnd");
      expect(member()?.status).toBe("dnd");
      sender.rollbackRefused("id-1");
      expect(member()?.status).toBe("online");
      expect(loadUserStatus()).toBe("online");
    });
  });

  it("has nothing to roll back for a frame that repeats the saved text and status", () => {
    withSender({}, ({ sender }) => {
      sender.send("online", "old text");
      // Another device changes the status before this frame is refused.
      updatePresence(1, "dnd");
      sender.rollbackRefused("id-1");
      expect(member()?.status).toBe("dnd");
    });
  });

  it("has nothing to roll back for a plain flip to the status already shown", () => {
    withSender({}, ({ sender }) => {
      sender.send("online");
      updatePresence(1, "dnd");
      sender.rollbackRefused("id-1");
      expect(member()?.status).toBe("dnd");
      expect(member()?.customStatus).toBe("old text");
    });
  });

  it("leaves out the text and expiry fields it was not given", () => {
    withSender({}, ({ sender, sent }) => {
      sender.send("dnd");
      expect(Object.keys(sent[0]!.payload)).toEqual(["status"]);
    });
    withSender({}, ({ sender, sent }) => {
      sender.send("dnd", "busy");
      expect(Object.keys(sent[0]!.payload)).toEqual(["status", "custom_status"]);
    });
  });

  it("rolls back to the last accepted status when several edits queue behind the limiter", () => {
    withSender({ fakeTimers: true }, ({ sender, sent }) => {
      saveUserStatus("online");
      sender.send("online", "first");
      saveUserStatus("dnd");
      sender.send("dnd", "second");
      saveUserStatus("idle");
      sender.send("idle", "third");
      expect(sent).toHaveLength(1);

      vi.advanceTimersByTime(11_000);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.payload.custom_status).toBe("third");

      // The server accepted the first frame, never the second: back to the first.
      sender.rollbackRefused("id-2");
      expect(member()?.status).toBe("online");
      expect(member()?.customStatus).toBe("first");
    });
  });

  it("clears the saved text when the refused frame replaced none", () => {
    membersStore.setState((p) => ({
      ...p,
      members: new Map([[1, { ...p.members.get(1)!, customStatus: undefined }]]),
    }));
    withSender({}, ({ sender }) => {
      saveCustomStatus("new text");
      sender.send("online", "new text");
      sender.rollbackRefused("id-1");
      expect(loadCustomStatus()).toBe("");
      expect(member()?.customStatus).toBeNull();
    });
  });

  it("restores how the status was chosen even when the status value is unchanged", () => {
    withSender({}, ({ sender }) => {
      saveUserStatus("online", "auto");
      sender.send("online", "hello");
      // The user then picks the same status by hand.
      saveUserStatus("online", "manual");
      sender.rollbackRefused("id-1");
      expect(loadUserStatus()).toBe("online");
      expect(loadUserStatusOrigin()).toBe("auto");
    });
  });

  it("cancels a queued retry when a later change goes straight out", () => {
    withSender({ fakeTimers: true }, ({ sender, sent }) => {
      saveUserStatus("dnd");
      sender.send("dnd");
      vi.advanceTimersByTime(1_000);
      saveUserStatus("invisible");
      sender.send("invisible"); // queued for t=11s
      expect(sent).toHaveLength(1);

      vi.advanceTimersByTime(9_500); // t=10.5s: the window has reopened
      saveUserStatus("idle");
      sender.send("idle");
      expect(sent).toHaveLength(2);

      vi.advanceTimersByTime(60_000);
      expect(sent).toHaveLength(2);
    });
  });

  it("sends nothing after destroy, neither a queued retry nor one for a late rate-limit reply", () => {
    withSender({ fakeTimers: true }, ({ sender, sent, fireError }) => {
      saveUserStatus("dnd");
      sender.send("dnd");
      saveUserStatus("idle");
      sender.send("idle"); // queued
      sender.destroy();
      vi.advanceTimersByTime(60_000);
      expect(sent).toHaveLength(1);

      fireError("RATE_LIMITED", "id-1");
      vi.advanceTimersByTime(60_000);
      expect(sent).toHaveLength(1);
    });
  });

  it("ignores other error codes for its own frame", () => {
    withSender({ fakeTimers: true }, ({ sender, sent, fireError }) => {
      saveUserStatus("dnd");
      sender.send("dnd");
      fireError("TIMED_OUT", "id-1");
      fireError("BAD_REQUEST", "id-1");
      vi.advanceTimersByTime(60_000);
      expect(sent).toHaveLength(1);
    });
  });

  it("keeps a newer queued change when a rate-limit reply for the earlier frame arrives", () => {
    withSender({ fakeTimers: true }, ({ sender, sent, fireError }) => {
      saveUserStatus("online");
      sender.send("online", "first");
      saveUserStatus("dnd");
      sender.send("dnd", "second"); // queued behind the limiter
      fireError("RATE_LIMITED", "id-1");
      vi.advanceTimersByTime(11_000);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.payload.status).toBe("dnd");
      expect(sent[1]!.payload.custom_status).toBe("second");
    });
  });

  it("does not match a reply without an id to a frame the transport gave no id", () => {
    withSender({ fakeTimers: true, returnIds: false }, ({ sender, sent, fireError }) => {
      saveUserStatus("dnd");
      sender.send("dnd");
      fireError("RATE_LIMITED", undefined);
      vi.advanceTimersByTime(60_000);
      expect(sent).toHaveLength(1);

      sender.rollbackRefused(undefined);
      expect(member()?.status).toBe("dnd");
    });
  });

  it("waits the full window plus a margin before retrying a rate-limited frame", () => {
    const limiter = {
      tryConsume: () => true,
      getRemainingMs: () => 5_000,
    } as unknown as RateLimiter;
    withSender({ fakeTimers: true, limiter }, ({ sender, sent, fireError }) => {
      saveUserStatus("dnd");
      sender.send("dnd");
      fireError("RATE_LIMITED", "id-1");
      vi.advanceTimersByTime(5_500);
      expect(sent).toHaveLength(1);
      vi.advanceTimersByTime(600);
      expect(sent).toHaveLength(2);
    });
  });
});
