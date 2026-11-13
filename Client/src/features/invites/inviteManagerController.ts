/** The invite manager overlay: its data mapping and the controller that opens it. */

import type { ApiClient } from "@lib/api";
import { ApiClientError, errorText } from "@lib/api";
import { canManageInvites } from "@lib/permissions";
import { createLogger } from "@lib/logger";
import { createLazyScreen } from "@lib/ui/lazyScreen";
import { createAsyncOverlayController } from "@lib/ui/asyncOverlay";
import type { InviteItem } from "./InviteManager";
import type { InviteResponse } from "@lib/types";
import { showToast } from "@lib/ui/toast";
import { authStore } from "@stores/auth.store";
import { formatInviteLink } from "@lib/nav/deepLink";
import { copyThenToast } from "@lib/ui/clipboard";
import { shellText } from "../../i18n/shell";

const log = createLogger("overlays");

const inviteManagerScreen = createLazyScreen("invite-manager", () => import("./InviteManager"));

function usernameOf(o: object): string {
  const name = "username" in o ? o.username : undefined;
  return typeof name === "string" ? name : "";
}

/** The signed-in user's name, or "" before sign-in. */
function myUsername(): string {
  return authStore.getState().user?.username ?? "";
}

/**
 * `fallbackCreator` names the creator when the reply carries none: the
 * create reply leaves creator_username empty, so an invite this client just
 * made passes the signed-in user. An erased creator stays "" and the dialog
 * leaves the creator out.
 */
export function mapInviteResponse(r: InviteResponse, fallbackCreator = ""): InviteItem {
  // The server now sends creator_username; the legacy nested created_by object
  // is kept as a fallback for an older server.
  const nested = "created_by" in r ? r.created_by : undefined;
  const creatorUsername =
    typeof r.creator_username === "string" && r.creator_username !== ""
      ? r.creator_username
      : typeof nested === "object" && nested !== null
        ? usernameOf(nested)
        : "";
  const uses = r.use_count ?? r.uses ?? 0;
  return {
    id: r.id,
    code: r.code,
    createdBy: creatorUsername !== "" ? creatorUsername : fallbackCreator,
    // created_at is when the invite was made; expires_at is when it lapses.
    // The old code set createdAt from expires_at, so the two were conflated.
    createdAt: r.created_at ?? "",
    uses,
    maxUses: r.max_uses,
    expiresAt: r.expires_at,
  };
}

/**
 * Whether the server marked this invite revoked. The list endpoint
 * deliberately still includes revoked invites, so the client filters them.
 * Without this, a revoked invite renders identically to a live one — Copy and
 * Revoke on a code that redemption always rejects.
 */
function isInviteRevoked(r: InviteResponse): boolean {
  return r.revoked === true;
}

/** Whether an invite's expiry has already passed, so it is not offered as a
 *  live code. A null expiry never expires. */
function isInviteExpired(r: InviteResponse): boolean {
  if (r.expires_at === null) return false;
  const t = Date.parse(r.expires_at);
  return Number.isNaN(t) ? true : t <= Date.now();
}

export interface InviteManagerController {
  open(): Promise<void>;
  cleanup(): void;
}

interface InviteLoad {
  readonly invites: InviteResponse[];
  readonly featuredCode: string | null;
  readonly screen: typeof import("./InviteManager");
}

const DEFAULT_INVITE_HOURS = 168;
const FRESH_INVITE_MIN_REMAINING_MS = 24 * 3_600_000;

/** Newest invite of the signed-in user that is still worth handing out: it has
 *  no use limit and is either non-expiring or expires more than 24 h from now. */
function newestLiveInvite(list: readonly InviteResponse[]): InviteResponse | null {
  let best: InviteResponse | null = null;
  let bestKey = -Infinity;
  const me = authStore.getState().user?.username ?? null;
  for (const r of list) {
    if (me === null || r.creator_username !== me) continue;
    // A limited invite can run out under the user, so it is never featured.
    if (r.max_uses !== null && r.max_uses > 0) continue;
    if (
      r.expires_at !== null &&
      Date.parse(r.expires_at) - Date.now() <= FRESH_INVITE_MIN_REMAINING_MS
    )
      continue;
    const created = r.created_at !== undefined ? Date.parse(r.created_at) : NaN;
    const key = Number.isNaN(created) ? r.id : created;
    if (best === null || key >= bestKey) {
      best = r;
      bestKey = key;
    }
  }
  return best;
}

export function createInviteManagerController(opts: {
  readonly api: ApiClient;
  readonly getRoot: () => HTMLDivElement | null;
}): InviteManagerController {
  const controller = createAsyncOverlayController<InviteLoad>({
    getRoot: opts.getRoot,
    // Only MANAGE_INVITES holders can list or create invites.
    canOpen: () => canManageInvites(),
    load: async () => {
      // Fetch the module alongside the list; a failed import rejects into the
      // controller's own load-failed dialog with Retry.
      const screenPromise = inviteManagerScreen.loadOrThrow();
      // The fetch below may throw first; the import must not go unhandled.
      screenPromise.catch(() => undefined);
      const raw = await opts.api.getInvites();
      const visible = raw.filter((r) => !isInviteRevoked(r) && !isInviteExpired(r));
      let featured = newestLiveInvite(visible);
      if (featured === null) {
        // Never more than one per open; a failure must not block the manager.
        try {
          featured = await opts.api.createInvite({
            expires_in_hours: DEFAULT_INVITE_HOURS,
            max_uses: 0,
          });
          // The create reply has no creator; this client made it.
          if ((featured.creator_username ?? "") === "") {
            featured = { ...featured, creator_username: myUsername() };
          }
          visible.push(featured);
        } catch (err) {
          log.error("Fresh invite create failed", { error: String(err) });
          showToast(errorText(err, shellText("invite.createFailed")), "error");
        }
      }
      return {
        invites: visible,
        featuredCode: featured?.code ?? null,
        screen: await screenPromise,
      };
    },
    build: (data, _root, close) => {
      const invites = data.invites.map((r) => mapInviteResponse(r));
      return data.screen.createInviteManager({
        invites,
        featuredCode: data.featuredCode,
        serverName: authStore.getState().serverName ?? null,
        formatLink: (code: string) => formatInviteLink(code, opts.api.getConfig().host),
        onCreateInvite: async (params) => {
          const created = await opts.api.createInvite({
            expires_in_hours: params.expiresInHours,
            max_uses: params.maxUses,
          });
          return mapInviteResponse(created, myUsername());
        },
        onRevokeInvite: async (id: number, code: string) => {
          try {
            try {
              await opts.api.revokeInvite(id);
            } catch (err) {
              // A server that predates revoke by id has no such route.
              if (!(err instanceof ApiClientError) || err.status !== 404) throw err;
              await opts.api.revokeInviteByCode(code);
            }
          } catch (err) {
            log.error("Invite revoke failed", { code, error: String(err) });
            throw err;
          }
        },
        onCopyLink: (code: string) => {
          // No silent success: a copy the user can't see is indistinguishable
          // from a clipboard permission failure.
          const link = formatInviteLink(code, opts.api.getConfig().host);
          copyThenToast(link, shellText("invite.copied"), shellText("invite.copyFailed"));
        },
        onClose: close,
        onError: (message: string) => {
          log.error(message);
          showToast(message, "error");
        },
      });
    },
    errorLog: "Failed to open invite manager", // i18n-exempt: developer log line, never shown
    errorToast: shellText("invite.loadFailed"),
    inlineError: { message: shellText("invite.loadFailed"), retryLabel: shellText("invite.retry") },
  });

  return { open: controller.open, cleanup: controller.close };
}
