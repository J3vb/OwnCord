# Plan: Slash command dispatcher in WS

**Status:** design only, not implemented

> **Staleness notes (2026-08-04):** this design predates several changes and
> needs a refresh before implementation: migration number `016` is now taken
> (`016_announcement_channel_type.sql` — the plan's `016_plugin_commands.sql`
> must be renumbered, as must its checklist); `Server/store/` no longer exists
> (deleted in D3 — the `sqlite_plugin_commands.go` file below would live in
> `Server/db/` now); `src/state/` does not exist in the client (state modules
> live in `src/stores/`). One slice of this plan did land separately: the
> manifest `commands` name-only ACL (see the inline note in §"Manifest").
**Owner:** TBD
**Tracks:** deferred feature backlog (post-beta; see CHANGELOG "Deferred work")
**Estimated effort:** 1–2 weeks of focused work

## Why

Discord's command system is the primary surface every bot/app uses. OwnCord
already ships:

- A plugin runtime (`Server/plugin/`) with a `commands` capability,
- `plugin.Registry.RegisterCommand` and `plugin.Registry.DispatchCommand`
  (`Server/plugin/host_commands.go`),
- A V2 WS dispatcher (`Server/ws/handlers_chat.go`,
  `Server/ws/command.go`) that already routes typed `Command` structs to
  pure handlers,
- A `chat_send` payload that flows through `MessageService.SendMessage`.

…but `chat_send` content beginning with `/` is currently treated as a
literal message. There is no dispatcher that recognises `/help`, no
autocomplete, no per-command argument schema, and the
`Registry.DispatchCommand` plumbing is dead code.

This plan wires the existing pieces together and adds the surface that
clients need to render slash commands the way Discord does.

## Non-goals

- **Not** an OAuth2/app directory (Tier 2 work — separate plan).
- **Not** a hosted "verified bot" registry — local plugins only.
- **Not** modal interactions or buttons/select menus (component v2). These
  are a follow-up; the v1 surface is text reply + ephemeral reply.
- **Not** a re-implementation of `MessageService` — slash commands take a
  separate path so they don't pollute the message table.

## Surface design

### Wire format

Two new client→server messages:

```json
// 1. Command invocation (from /chat input or autocomplete pick)
{
  "type": "command_invoke",
  "req_id": "c-42",
  "payload": {
    "channel_id": 17,
    "name": "kick",
    "args": [
      {"name": "user",   "value": "12345"},
      {"name": "reason", "value": "spam"}
    ]
  }
}

// 2. Autocomplete query (sent on every keystroke after `/`)
{
  "type": "command_autocomplete",
  "req_id": "c-43",
  "payload": {
    "channel_id": 17,
    "name": "kick",
    "focused": "user",
    "partial": "ali",
    "args": [{"name": "user", "value": "ali"}]
  }
}
```

Two new server→client messages:

```json
// Successful invocation reply (ephemeral by default).
{
  "type": "command_reply",
  "req_id": "c-42",
  "payload": {
    "ephemeral": true,
    "content":   "Kicked alice for: spam.",
    "embeds":    [],
    "broadcast": null
  }
}

// Autocomplete suggestions.
{
  "type": "command_autocomplete_result",
  "req_id": "c-43",
  "payload": {
    "choices": [
      {"label": "alice (id 12345)", "value": "12345"},
      {"label": "alistair (id 67)", "value": "67"}
    ]
  }
}
```

The ephemeral reply is delivered only to the invoking client (it never hits
`MessageSentChannelEvent`). The optional `broadcast` field, when non-null,
becomes a real `chat_message` posted by a synthetic `Bot:<plugin-name>`
identity so the channel timeline records it.

### Manifest changes

Plugin manifests gain a `commands` block. The manifest is the source of
truth for the per-command schema; the runtime never trusts what the plugin
says at dispatch time. Example:

> **Partially landed 2026-07-20** (audit-2026-04-07 CRITICAL #3): the
> *name-only* slice of this block exists today — `plugin.json` accepts
> `"commands": [{"name": "kick"}]` and `Registry.RegisterCommand` refuses any
> command the manifest did not declare, so `list_commands` can no longer bind
> names behind the admin's back. `description` / `options` /
> `default_member_permissions` below are still design-only; unknown keys parse
> and are ignored, so manifests written against the full schema already load.

```json
{
  "name": "moderation-tools",
  "version": "0.2.0",
  "entrypoint": "mod.wasm",
  "permissions": ["commands", "events"],
  "commands": [
    {
      "name": "kick",
      "description": "Remove a user from the server.",
      "default_member_permissions": ["kick_members"],
      "options": [
        {
          "name": "user",
          "type": "user",
          "description": "Who to kick.",
          "required": true,
          "autocomplete": true
        },
        {
          "name": "reason",
          "type": "string",
          "description": "Optional reason recorded in audit log.",
          "max_length": 256
        }
      ]
    }
  ]
}
```

`Manifest.Validate` (`Server/plugin/manifest.go`) gets a new
`validateCommands()` step:

- `name`: same regex as plugin names (`^[a-z][a-z0-9_-]{0,31}$`),
  forced lowercase, **no spaces**, **no slashes**, max 32 chars.
- `description`: 1–100 chars, no NUL/control bytes.
- `options`: max 25, each `name` unique, recurses on nested groups.
- `option.type`: closed enum (`string`, `int`, `bool`, `user`, `channel`,
  `role`, `mention`, `attachment`, `subcommand`, `subcommand_group`).
- `default_member_permissions`: closed enum matched against
  `permissions.Permission` constants (so a typo fails at install, not at
  dispatch).

Same defense profile as the existing manifest validation: the closed-set
checks live in `manifest.go` next to `validCapabilities`.

### Schema additions

A new table to support **server-installed plugin commands without
duplicating the manifest** — needed so the WS hub can answer
`command_autocomplete` requests without doing a JSON walk on every keystroke:

```sql
-- migrations/016_plugin_commands.sql
CREATE TABLE plugin_commands (
    plugin_id    INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    schema_json  TEXT    NOT NULL,         -- the validated `commands[i]` blob
    permissions  INTEGER NOT NULL DEFAULT 0, -- packed permission bits
    PRIMARY KEY (plugin_id, name)
);
CREATE UNIQUE INDEX plugin_commands_name_uq ON plugin_commands(name);
```

The unique index on `name` enforces that two enabled plugins can't both
own `/ban` — install of the second one fails. This is intentional: command
namespace collisions are confusing for users.

### Code surface

| File | Change |
|---|---|
| `Server/ws/message_types.go` | Add `MsgTypeCommandInvoke`, `MsgTypeCommandAutocomplete`, `MsgTypeCommandReply`, `MsgTypeCommandAutocompleteResult`. |
| `Server/ws/command.go` | Add `CommandInvokeCmd`, `CommandAutocompleteCmd` structs and constructors. Validate name regex + arg count cap (25) at parse time so the dispatcher trusts its input. |
| `Server/ws/handlers_command.go` | **New file.** `handleCommandInvokeV2`, `handleCommandAutocompleteV2`. Pure handlers — return a `Result` like the existing chat handlers. |
| `Server/ws/handlers.go` | Register the new handlers via `r.RegisterV2(MsgTypeCommandInvoke, handleCommandInvokeV2, deps)`. |
| `Server/ws/deps.go` | Add a `CommandDeps` carrying `*plugin.Registry`, `service.PermissionService`, and `service.MessageService`. |
| `Server/plugin/host_commands.go` | Extend `DispatchCommand` to take a typed arg map (`map[string]any`) instead of `[]string`. Add `Autocomplete(ctx, name, focused, partial)`. |
| `Server/plugin/manifest.go` | Add `Commands []CommandSpec` to `Manifest`, `validateCommands()`, and a `Manifest.Command(name)` lookup. |
| `Server/store/sqlite_plugin_commands.go` | **New file.** CRUD over the `plugin_commands` table. |
| `Server/migrations/016_plugin_commands.sql` | New migration. |
| `Client/src/state/commands.ts` | **New module.** Caches per-server command list (fetched at `auth_ok` time via a new `commands_list` REST endpoint), feeds the autocomplete UI. |
| `Client/src/components/Composer/SlashCommandPopup.tsx` | New component — autocomplete dropdown that opens when the message buffer starts with `/`. |
| `docs/protocol.md` | Document the four new wire messages. |

### Permission model

`default_member_permissions` is enforced **server-side** in
`handleCommandInvokeV2` *before* the plugin is invoked, by calling
`PermissionService.HasChannelPerm` for each declared permission. Plugins
do not get to decide who can use their commands; the manifest declares,
the host enforces.

Slash commands inherit the existing channel ACL: `command_invoke` for a
channel the user can't `view_channel` in returns `ErrCodeForbidden` with
no plugin invocation, no telemetry leak.

### Built-in commands

Two slash commands ship in-tree (no plugin required), to validate the
dispatcher and to give bare-metal deployments something useful:

| Command | Implementation | Why in-tree |
|---|---|---|
| `/me <text>` | Built-in handler in `handlers_command.go` | Discord parity, IRC tradition. |
| `/shrug` | Built-in handler | Same. Trivial. |

A future PR can add `/poll`, `/remind`, `/nick` etc. — all should follow
the same handler shape so a plugin author can read the source as the
canonical example.

## Concurrency & lifecycle

- Plugin command registration happens at `Registry.activateAll` time
  (already exists for the wazero build) and at `installFromDisk` for the
  default build.
- `plugin_commands` rows are written inside the same transaction as
  `plugins` so a half-installed plugin can never have orphan rows.
- `DispatchCommand` runs the plugin handler **off the WS goroutine** with a
  3 s context deadline (configurable via `config.yaml > plugins.command_deadline_ms`).
  A slow command must not block `chat_send` for the same client.
- The 3 s budget is enforced by passing `context.WithTimeout` into
  `Registry.DispatchCommand`; the wazero runtime already accepts a `ctx`
  on every host call.

## Failure modes & UX

| Failure | Server response | Client UX |
|---|---|---|
| No such command | `command_reply` ephemeral: `Unknown command: /foo` | Red banner under composer. |
| Plugin runtime not built (default build) | Existing fallback in `DispatchCommand` returns the helpful error message | Same banner, no crash. |
| Plugin handler timeout (>3s) | `command_reply` ephemeral: `/foo timed out` + audit log entry | Banner + telemetry tag. |
| Plugin handler panics | Recovered in the runtime, ephemeral error, plugin auto-disabled after 3 panics in 60s | Banner + plugin marked unhealthy in admin panel. |
| Permission denied | `command_invoke` returns `ErrCodeForbidden` before invocation | Banner: "You lack permission". |
| Argument validation fails | `command_invoke` returns `ErrCodeBadPayload` with the field name | Composer highlights the bad option. |

## Testing strategy

Unit:
- `manifest_test.go` — extend with command validation (name regex, option
  type enum, max 25 options, max 100 char description).
- `host_commands_test.go` — `DispatchCommand` with a stub `Instance`,
  arg-map round trip, auto-disable after panics.
- `handlers_command_test.go` — pure handler test using the existing
  V2 test pattern (`stubMessageSvc`, `stubPermSvc`).

Integration:
- Add a new in-tree test plugin under `Server/plugin/examples/echo` (no
  wasm needed — installable via the default build) that registers `/echo`
  and is loaded inside `ws_integration_test.go`.

Contract:
- `docs/protocol.md` round trip — JSON examples kept in sync with the
  parser via golden tests.

## Telemetry

Three new counters under `commands_*`:

- `commands_invoked_total{name,plugin,result}`
- `commands_autocomplete_total{name,plugin}`
- `commands_duration_ms_bucket{name,plugin}` (histogram)

Existing OTel skeleton (`Server/telemetry/`) gets a new
`tracer.Start(ctx, "command.invoke")` span around `DispatchCommand`.

## Rollout

1. Land schema migration + manifest validation behind the existing
   default build. New plugins can declare commands but the WS dispatcher
   still treats `/` as plain text.
2. Land WS dispatcher + `/me` / `/shrug` built-ins. Slash commands work
   for in-tree handlers, plugin commands still no-op.
3. Land the autocomplete RPC + client UI. Composer learns to open the
   popup on `/`.
4. Land `Registry.DispatchCommand` wiring so plugin commands route through.
   Gate behind `-tags wazero` for the actual invocation; the default
   build returns the existing helpful "runtime not built" message.

Each step is independently shippable.

## Open questions

1. **Bot identity for broadcast replies.** When a slash command produces a
   `broadcast`, who is the author? Options: (a) a virtual `Bot:<name>`
   user with a synthetic ID in a reserved namespace, (b) the invoking
   user (Discord style: "Used /poll"). I'm leaning (b) for simplicity —
   it avoids new identity rows — but it loses the visual distinction. TBD
   in review.
2. **Component v2 (buttons / selects).** Out of scope for v1 but the
   wire-format reservations should leave room for a `components` array on
   `command_reply`. Worth adding the field as `[]any` now even though
   nothing renders it, so v2 isn't a breaking change.
3. **Cross-plugin command imports.** Discord allows one app to use another's
   commands. We don't, and shouldn't until there's a real reason — the
   namespace flatness is a feature for a self-hosted product.
4. **DM-context commands.** Some commands make sense in DMs (`/poll`),
   some don't (`/kick`). Add a manifest field `contexts: ["channel", "dm"]`
   defaulting to `["channel"]`.

## Files-to-touch checklist (for the implementing agent)

- [ ] `Server/migrations/016_plugin_commands.sql`
- [ ] `Server/plugin/manifest.go` — `CommandSpec`, `validateCommands`
- [ ] `Server/plugin/manifest_test.go` — command validation table
- [ ] `Server/plugin/host_commands.go` — typed args, autocomplete
- [ ] `Server/store/sqlite_plugin_commands.go`
- [ ] `Server/ws/message_types.go` — four new constants
- [ ] `Server/ws/command.go` — `CommandInvokeCmd`, `CommandAutocompleteCmd`
- [ ] `Server/ws/handlers_command.go` — V2 handlers + `/me` + `/shrug`
- [ ] `Server/ws/handlers.go` — register new handlers
- [ ] `Server/ws/deps.go` — `CommandDeps`
- [ ] `Server/ws/handlers_command_test.go`
- [ ] `Server/api/router.go` — `GET /api/v1/commands` (cached schema dump)
- [ ] `Client/src/state/commands.ts`
- [ ] `Client/src/components/Composer/SlashCommandPopup.tsx`
- [ ] `docs/protocol.md` — four new wire messages
- [ ] `CHANGELOG.md` — Phase D entry
