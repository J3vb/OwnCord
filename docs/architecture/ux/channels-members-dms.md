# Channels, Members & Direct Messages — target UX

**Verified against:** commit `da4acc5`, 2026-07-19
Part of the [Client UX Specification](README.md).

Covers the sidebar surfaces: the channel list (switch, categories, reorder,
announcement affordance), the member list (presence, typing, roles), and DMs
(open/close, blocking).

---

## 1. Channel sidebar

Renders from `channels.store` (`channels` map, `activeChannelId`), grouped by
category, sorted by position. The sidebar has two modes (`ui.store.sidebarMode`):
`channels` and `dms`.

| State | Trigger | Target reaction |
|-------|---------|-----------------|
| `ready` | Channels loaded from `ready` | Grouped, collapsible category list |
| `empty` | Zero channels | "No channels yet" + hint (already `ChannelSidebar.ts:422-430`) |
| category collapsed | User toggles | Persisted per-server in localStorage (`ui.toggleCategory`); chevron reflects state |
| active channel | `setActiveChannel` | Highlighted; unread cleared |
| unread | `chat_message` in a non-active channel | Unread pill; badge on the channel |

### 1.1 Channel type affordances

Each channel type gets a distinct icon and interaction:

| Type | Icon | Click behavior |
|------|------|----------------|
| `text` | hash | Focus → load messages |
| `announcement` | megaphone (D1) | Focus → load messages; **composer read-only unless MANAGE_MESSAGES** (see [messaging.md §2](messaging.md)) |
| `voice` | speaker | Join voice (see [voice-and-e2ee.md](voice-and-e2ee.md)); shows the participant roster inline |
| `dm` | — | Not in the channel list; lives in DM mode |

### 1.2 Channel switching

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant CS as ChannelSidebar
    participant CH as channels.store
    participant CC as ChannelController
    U->>CS: click channel
    CS->>CH: setActiveChannel(id)  %% clears that channel's unread
    CH-->>CC: activeChannelId change
    CC->>CC: mountChannel(id, type) — MessageList + Typing + Composer
    CC->>SRV: channel_focus{channel_id}  %% server read-state
```

**Target rules:**
- Switching is instantaneous from cache; the message area shows its own loading
  state for uncached history ([messaging.md §1](messaging.md)), never a global block.
- If the active channel is **deleted** server-side (`channel_delete`), redirect to
  the first text channel by position and toast "This channel was deleted."
  (redirect already exists, `dispatcher.ts:286-292`; add the toast).

### 1.3 Reorder & CRUD (admin)

Drag-reorder and create/edit/delete are admin affordances — see
[settings-and-admin.md §3](settings-and-admin.md). **Target:** reorder should be
optimistic (position updates locally, then `PATCH` per moved channel) and roll
back on failure.

---

## 2. Member list

Renders from `members.store` (`members` map + `typingUsers`). Shows presence and
role grouping.

| State | Trigger | Target reaction |
|-------|---------|-----------------|
| `ready` | `ready.members` | Grouped by role, sorted; presence dot per member |
| `empty` | No online members | "No members online" (already `MemberList.ts:167-170`) |
| presence change | `presence` event | Live dot update; offline members styled distinctly |
| role change | `member_update` | Re-group live |
| profile change | `user_update` | Name/avatar update; if it's us, also patch `auth.store` (already `dispatcher.ts:334-341`) |
| join/leave/ban | `member_join`/`member_leave`/`member_ban` | Add/remove with no reflow flash |

### 2.1 Typing indicator

`typing` events populate `members.typingUsers` with a 5 s auto-clear timer.
**Target:** show "X is typing…" / "X and Y are typing…" / "Several people are
typing…" below the message list, excluding the current user (already
`TypingIndicator.ts:35`). The client emits `typing_start` while composing
(debounced), never per-keystroke.

### 2.2 Member actions (context menu)

Right-click / long-press a member → context menu (roles, kick, ban) — moderation
affordances covered in [settings-and-admin.md §3](settings-and-admin.md). Actions
the user lacks permission for are **not shown** (menu items gated by the actor's
role), consistent with the affordance principle.

> **⚠ Current gap — role source split.** Role lookups read from two stores that
> aren't kept in sync: `channels.store` carries `roles`/`getRoleIdByName` (wired
> in the dispatcher) while a parallel `roles.store` exposes the same API, consumed
> by `SidebarMemberSection.ts:11` — only `channels.store.setRoles` is updated by
> `ready` (`dispatcher.ts:10`). Target: one role store, one writer. A stale
> `roles.store` can mis-map a role name→id in the member context menu.

---

## 3. Direct messages

DM mode (`sidebarMode: "dms"`) renders from `dm.store` (`channels` list, each with
recipient, last-message preview, unread).

| State | Trigger | Target reaction |
|-------|---------|-----------------|
| `ready` | `ready.dm_channels` | DM list sorted by recency |
| `empty` | No DMs | "No direct messages yet" + "Start one from a member's profile" |
| open DM | `dm_channel_open` | Prepend/move-to-top, dedup (already `dm.store.ts:38`) |
| close DM | `dm_channel_close` | Remove from list |
| new DM message | `chat_message` in a DM | `updateDmLastMessage` (unread bump + reorder) if not focused; `updateDmLastMessagePreview` (no bump) if own/active |
| last-message empty | Never messaged | "No messages yet" fallback (already `SidebarDmHelpers.ts:127`) |

### 3.1 Opening a DM

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant P as Member profile popup
    participant API as api.ts
    participant DM as dm.store
    U->>P: "Message" on a member
    P->>API: POST /dms {recipient_id}
    API-->>P: DM channel
    P->>DM: open DM mode + focus channel
    Note over U,DM: server also broadcasts dm_channel_open to both parties
```

### 3.2 Blocking

Blocking gates DM delivery server-side (a blocked user can't post into the DM,
and `IsEitherBlocked` is bidirectional). **Target UX:**

| Action | Reaction |
|--------|----------|
| Block user | Confirm → block; DM composer becomes read-only with "You've blocked this user. Unblock to send messages." |
| Being blocked | Composer read-only with a neutral "You can't message this user right now." (do not reveal the block state explicitly — the server returns a generic refusal) |
| Unblock | Composer re-enables |

> **⚠ Current gap.** There is no client-side block-state composer gating. The
> composer now has a disabled-with-reason mode (see [messaging.md §2](messaging.md)),
> but DM channels are left ungated: the block/unblock REST surface exists
> server-side, and the client refuses a DM send only via the failed-row /
> `FORBIDDEN` path today. Target ties DM block state into the same
> composer-state machine.

---

## Source of truth

`src/components/ChannelSidebar.ts` (+ `channel-sidebar/`),
`src/components/MemberList.ts`, `src/components/TypingIndicator.ts`,
`src/components/DmSidebar.ts`, `src/components/DmProfileSidebar.ts`,
`src/pages/main-page/SidebarArea.ts`, `SidebarMemberSection.ts`,
`SidebarDmSection.ts`, `SidebarDmHelpers.ts`, `src/stores/channels.store.ts`,
`members.store.ts`, `dm.store.ts`, `roles.store.ts`, `src/lib/dispatcher.ts`;
server `Server/service/channel.go`, `dm.go`, `block.go`.
