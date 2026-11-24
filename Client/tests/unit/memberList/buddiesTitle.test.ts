import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuddiesTitle } from "../../../src/features/members/buddies/buddiesTitle";
import { membersStore, updatePresence } from "@stores/members.store";
import { makeMember, setTestMembers } from "../../helpers/memberListHarness";
import { resetMembersState } from "../../helpers/storeResets";

describe("createBuddiesTitle", () => {
  let owner: AbortController;

  beforeEach(() => {
    owner = new AbortController();
    resetMembersState();
    setTestMembers([
      makeMember({ id: 1, username: "ann" }),
      makeMember({ id: 2, username: "bob", status: "idle" }),
      makeMember({ id: 3, username: "cy", status: "offline" }),
      makeMember({ id: 4, username: "di", status: "invisible" }),
    ]);
    membersStore.flush();
  });

  afterEach(() => owner.abort());

  it("shows Buddies and the online count out of everyone, spoken in words", () => {
    const title = createBuddiesTitle(owner.signal);
    expect(title.dataset["testid"]).toBe("buddies-title");
    expect(title.querySelector("h2.buddies-title-text")?.textContent).toBe("Buddies");
    const count = title.querySelector<HTMLElement>('[data-testid="buddies-count"]')!;
    expect(count.textContent).toBe("2/4");
    expect(count.getAttribute("aria-hidden")).toBe("true");
    expect(title.querySelector(".sr-only")?.textContent).toBe("2 of 4 online");
  });

  it("patches the count in place when the roster changes", () => {
    const title = createBuddiesTitle(owner.signal);
    const count = title.querySelector('[data-testid="buddies-count"]');
    updatePresence(3, "online");
    membersStore.flush();
    expect(title.querySelector('[data-testid="buddies-count"]')).toBe(count);
    expect(count?.textContent).toBe("3/4");
    expect(title.querySelector(".sr-only")?.textContent).toBe("3 of 4 online");
  });

  it("stops following the roster when its owner ends", () => {
    const title = createBuddiesTitle(owner.signal);
    owner.abort();
    updatePresence(3, "online");
    membersStore.flush();
    expect(title.querySelector('[data-testid="buddies-count"]')?.textContent).toBe("2/4");
  });
});
