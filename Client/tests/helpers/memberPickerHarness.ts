import { beforeEach } from "vitest";
import { authStore } from "../../src/stores/auth.store";
import { useMountContainer } from "./mountContainer";

/** A member row as membersStore holds it. */
export function memberRow(id: number, username: string) {
  return {
    id,
    username,
    avatar: null,
    role: "member",
    status: "online" as const,
    displayName: null,
  };
}

/**
 * Registers the hooks for a MemberPickerModal suite: a mount container, a
 * signed-in "me", and teardown of every picker pushed onto `opened` plus any
 * leftover modal overlay.
 */
export function useMemberPickerHarness(bind: (container: HTMLDivElement) => void): {
  opened: { destroy?(): void }[];
} {
  const opened: { destroy?(): void }[] = [];

  useMountContainer(bind, () => {
    for (const picker of opened.splice(0)) picker.destroy?.();
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
  });

  beforeEach(() => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 1, username: "me", avatar: null, role: "member" } as never,
    }));
  });

  return { opened };
}
