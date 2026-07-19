# OwnCord Client UX Specification (target state)

**Verified against:** commit `da4acc5`, 2026-07-19
**Companion:** [../client.md](../client.md) (structural module map) · [../../audit-2026-07-19.md](../../audit-2026-07-19.md)

This directory specifies **how the Tauri client should behave** — what every UI
step does, and how each view reacts to server events, permission state, and
failure. Unlike [client.md](../client.md), which maps the code as-built, these
documents are **prescriptive (to-be)**: they describe the intended target UX.
Where today's code diverges, each flow carries a **⚠ Current gap** callout — so
this set doubles as a UX improvement backlog. Gaps are grounded in real
`file:line` references from the client.

> **Scope.** This is a behavior spec, not a visual design spec. It defines
> states, transitions, events, and reactions — not pixel layout, spacing, or
> color. Those live in `src/styles/tokens.css` and the component CSS.

## Documents

| Doc | Covers |
|-----|--------|
| [connection-and-auth.md](connection-and-auth.md) | App boot, server profiles, connect/health, login, TOTP, register-by-invite, the connected handshake, reconnect, and cert-TOFU trust prompts |
| [messaging.md](messaging.md) | Composer + send (optimistic), edit/delete, reactions, attachments, replies, pins, search, read/unread, slow-mode, announcement read-only gating |
| [channels-members-dms.md](channels-members-dms.md) | Channel list/switch/categories, member list + presence + typing, roles, DM open/close, blocking |
| [voice-and-e2ee.md](voice-and-e2ee.md) | Voice join/leave, mute/deafen/camera/screenshare, push-to-talk, active-speaker, and the E2EE securing/key-ready indicators |
| [settings-and-admin.md](settings-and-admin.md) | Settings tabs, profile/password/2FA/delete-account, appearance/theming, the inline admin surface (ban/kick/roles, channel CRUD, invites), and the updater |

The cross-cutting vocabulary and global reaction matrices below apply to **every**
document; the per-flow docs reference them rather than repeating them.

---

## 1. View-state vocabulary

Every data-bearing view must be able to represent each of these states and must
choose a defined presentation for each (a view may legitimately collapse some —
e.g. a view that can never be empty — but that must be a decision, not an
omission):

| State | Meaning | Default presentation |
|-------|---------|----------------------|
| `loading` | A fetch/subscription is in flight and no cached data is shown yet | Skeleton or inline spinner in the view's own region — **never** a full-screen blocker except the initial connected handshake |
| `ready` | Data present and current | The normal view |
| `empty` | Fetch succeeded, zero items | A labelled empty state with a one-line "what goes here / what to do next" hint |
| `error` | Fetch/action failed | Inline error with a **Retry** affordance for recoverable errors; a toast only for fire-and-forget actions |
| `stale` | Data shown but known out of date (e.g. during reconnect) | The normal view plus a non-blocking status hint (connection banner); interactions that require a live socket are disabled with a reason |
| `permission-denied` | The user may see the view but not act | The view renders read-only; the disallowed control is **disabled with a visible reason**, never hidden silently and never enabled-then-rejected |
| `offline` | No live socket | Live-only controls disabled with the connection status surfaced |

**Principle — no silent states.** Every terminal outcome (success, empty,
failure, denial) produces *some* observable feedback. A control that will be
rejected by the server must be pre-disabled with a reason; an action that
succeeds without a visible result must emit a confirmation.

---

## 2. Feedback primitives

The client has a fixed set of feedback surfaces. Each has one job; pick by the
decision table, don't improvise.

| Primitive | Source | Use for | Do **not** use for |
|-----------|--------|---------|--------------------|
| **Toast** (`info`/`success`/`error`, 5 s auto-dismiss, max 5) | `lib/toast.ts` → `components/Toast.ts` | Transient results of an explicit user action (sent, copied, saved, "couldn't reach server") | Anything the user must act on; anything that must survive navigation |
| **Inline field error** | per-form | Validation and per-field server rejections (bad password, weak input) | Global/connection state |
| **Inline section error + Retry** | per-view | A failed load of a view's own data (messages, invites, pins) | One-shot actions (use a toast) |
| **Persistent banner** | `components/ServerBanner.ts` (reconnect/restart), ad-hoc cert banner | Connection status: reconnecting, server-restart countdown, first-trust cert notice | Per-action results |
| **Blocking modal** | `lib/modalFactory.ts` (+ `CertMismatchModal`) | Decisions that must be made before proceeding: cert mismatch, destructive confirm | Routine feedback; anything dismissable-by-ignoring |
| **Two-click / inline confirm** | `AdminActions.ts` `withConfirmation`, `PendingDeleteManager` | Reversible-ish destructive actions in dense menus (kick, ban, delete channel, delete message) | Irreversible account-level actions (use a modal with typed confirm) |
| **Disabled control + reason** | per-control | Actions not currently permitted (offline, no permission, slow-mode cooldown, upload in flight) | Errors that already happened |
| **Transient-error store** (`ui.store.setTransientError`) | survives navigation | A message that must appear on the *connect* page after a forced disconnect (banned, kicked, restart) | In-session messaging (use a toast) |

---

## 3. Connection status is a first-class, observable state

Every live-only interaction keys off one connection status. Target: a single
source of truth in `ui.store.connectionStatus`
(`connected | reconnecting | disconnected`), written from the WS client's
`onStateChange`, and read by any control that needs a live socket.

> **✓ Implemented (2026-07).** `ui.store.connectionStatus` is now the single
> source of truth: `main.ts` registers the one writer
> (`ws.onStateChange` → `toConnectionStatus` → `setConnectionStatus`), mapping
> the internal 5-state machine onto the 3-state status (`connecting` /
> `authenticating` read as `reconnecting`, since a reconnect cycle passes
> through them). Consumers subscribe to the store instead of wiring ad-hoc
> callbacks: the reconnect banner (`MainPage`, which now also shows
> "Disconnected" instead of going stale), the composer gating
> (`ChannelController`), and the presence picker (`UserBar` — previously dead in
> production because `SidebarArea` never passed it a `ws`; it now gates on the
> store and receives the `ws` send path). The one-shot connected-overlay wiring
> in `main.ts` stays on `ws.onStateChange` deliberately — it needs the exact
> internal transition. Voice controls remain independent: LiveKit reconnection
> "retries underneath" per the table below.

| Status | Composer / send | Voice controls | Presence picker | Reconnect banner |
|--------|-----------------|----------------|-----------------|------------------|
| `connected` | enabled | enabled | enabled | hidden |
| `reconnecting` | disabled, "Reconnecting…" | frozen, retrying underneath | disabled | visible, spinner |
| `disconnected` | disabled | torn down | disabled | visible or → connect page on fatal |

---

## 4. Global event → reaction map

The dispatcher (`src/lib/dispatcher.ts`) is the single fan-in from the socket to
the stores. Target: **every** inbound message type produces a defined store
mutation *and*, where user-visible, a defined UI reaction. The per-flow docs
detail each; this is the index.

| Inbound event | Store effect | Target UI reaction |
|---------------|--------------|--------------------|
| `auth_ok` | `auth.setAuth` | Advance handshake → ready overlay |
| `auth_error` | `ui.setTransientError` + `auth.clearAuth` | Return to connect page with the reason shown |
| `ready` | bulk-load channels/roles/members/voice/dm | Render main view; resolve the connected overlay |
| `chat_message` | `messages.addMessage` (+ unread/DM/notify) | Append; reconcile a pending optimistic row if it's our echo |
| `chat_send_ok` | `messages.confirmSend` | Mark the optimistic row **sent** (see gap in [messaging.md](messaging.md)) |
| `chat_edited` / `chat_deleted` | `messages.editMessage` / `deleteMessage` | In-place edit / tombstone |
| `reaction_update` | `messages.updateReaction` | Toggle the pill + count, reflect `me` |
| `typing` | `members.setTyping` (5 s auto-clear) | Typing indicator |
| `presence` / `member_update` / `user_update` | `members.*` | Live member-list update |
| `member_join` / `member_leave` / `member_ban` | `members.add/remove` | Member-list add/remove |
| `channel_create` / `channel_update` / `channel_delete` | `channels.*` | Sidebar update; redirect if the active channel was deleted |
| `voice_state` / `voice_leave` / `voice_config` / `voice_speakers` | `voice.*` | Voice roster + speaking rings |
| `voice_token` / `voice_e2ee_*` | `livekitSession.*` | Drive the voice-join + securing indicators |
| `dm_channel_open` / `dm_channel_close` | `dm.*` | DM list add/remove |
| `server_restart` | `ui.setTransientError` | Restart banner with countdown |
| `error` | `ui.setTransientError` (+ `clearAuth` on `BANNED`) | Map the code → the reaction in §5 |

> **✓ Implemented (2026-07).** Error codes are no longer silently dropped for
> sends: the server echoes the request id on error replies, so `SLOW_MODE`,
> `FORBIDDEN`, `RATE_LIMITED`, `BAD_REQUEST`, etc. are mapped to the exact
> optimistic row that failed (retry offered), and `chat_send_ok`'s
> `message_id`/`timestamp` now reconcile the pending row. See the optimistic
> lifecycle in [messaging.md](messaging.md).

---

## 5. Error & permission reaction matrix

One canonical reaction per failure class, applied everywhere. Today error
handling is per-call-site with no shared mapper (`api.ts:81-140` centralizes only
401); this matrix is the target contract.

| Class | Source | Target reaction |
|-------|--------|-----------------|
| **401 Unauthorized** | any REST call | Global: `clearAuth()` → disconnect → connect page, with "Your session expired — sign in again." (centralized in `api.ts` + `main.ts`; since 2026-07 `uploadFile` honors it too, and the connect page shows the session-expired reason) |
| **403 Forbidden** (action) | REST/WS | Toast "You don't have permission to do that." **and** pre-disable the control so it can't be attempted again in that context |
| **403 Suspended/Banned** | login REST / WS `BANNED` | Transient-error store → connect page: "Your account has been suspended." Force logout, no reconnect |
| **429 Rate-limited** | REST/WS `RATE_LIMITED` | Non-destructive toast "You're doing that too fast — try again in a moment." Keep the user's input; re-enable the control after a short cooldown |
| **Slow-mode** | WS `SLOW_MODE` | Disable send with a live countdown in the composer; do not drop the drafted message |
| **Validation (400)** | REST | Inline field error with the server message (capped to a safe length — the login form caps at 200 chars, `LoginForm.ts:598`; apply everywhere) |
| **Conflict/Not-found (404/409)** | REST/WS | Contextual inline message + refresh the affected view (the target moved/vanished) |
| **5xx / network** | REST | Inline section error + **Retry**; for one-shot actions, a toast "Couldn't reach the server." Never a silent drop |
| **Transport backpressure** | WS `ws_send` "channel full" | Mark the optimistic row failed with Retry (✓ since 2026-07: `ws.onSendFailure` → dispatcher → `markSendFailed` with `NETWORK`/`OFFLINE`; id-less sends like heartbeats stay silent) |
| **Cert first-use** | Rust `cert-tofu: trusted_first_use` | 8 s informational banner (already: `main.ts:105-129`) |
| **Cert mismatch** | Rust `cert-tofu: mismatch` | Blocking `CertMismatchModal`; Accept re-pins + reconnects, Reject disconnects + returns to connect (already: `main.ts:133-164`) |

---

## 6. Cross-cutting principles

1. **Optimistic where the user acts, authoritative where the server decides.**
   Local actions (send, react, mute) reflect immediately with a *pending* marker,
   then reconcile against the server echo; on failure they roll back visibly with
   a retry — never silently.
2. **Permission is expressed as affordance, not as rejection.** If the server
   will refuse, the client disables the control with a reason first. The
   announcement-channel composer is the canonical example (see
   [messaging.md](messaging.md)).
3. **Connection state gates live controls reactively** (§3), not per-click.
4. **One reaction per failure class** (§5), applied uniformly.
5. **No silent success and no silent failure** (§1).

## Maintenance rule

Same as the blueprint set: if a PR changes a client flow, event handler, or the
set of states a view must represent, it updates the corresponding UX doc in the
same change. These specs reference stable identifiers (event-type strings, store
action names, component names) over line numbers; the `file:line` anchors in the
gap callouts are point-in-time and dated by the header.
