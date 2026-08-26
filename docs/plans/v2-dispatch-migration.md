# Finish the V2 Dispatch Migration (backlog item 11) — Design

**Status:** implemented 2026-07-20 (D10) — re-verified 2026-08-04
(`Server/ws/registry.go` holds only `handlersV2`; no V1 registry symbols
remain)
**Decision:** D10 in [audit-2026-07-19-decisions.md](audit-2026-07-19-decisions.md)
**Closes:** audit finding A-2026-07-09 (backlog §6 item 11)

## Problem

`ws.handleMessage` runs a strangler-fig: for each inbound type it tries the
strict V2 typed path (`registry.hasV2` → `getCommandConstructor` → `DispatchV2`,
returning a `Result{}`) and otherwise falls back to the lenient V1 path
(`registry.Dispatch` → imperative `MessageHandler`). Two parsers, two registries
(`handlers` / `handlersV2`), and per-type duplication must be kept in sync until
the migration completes.

## Current state — only 3 types remain on V1

Everything else is already V2: chat send/edit/delete, reaction add/remove, ping,
typing, presence, channel_focus, voice mute/deafen/camera/screenshare, voice
E2EE announce/offer, voice_token_refresh. The V1 holdouts are:

- `chat_command` → `handlePluginCommand` (`handlers_command.go`),
- `voice_join` → `handleVoiceJoin` (`handlers_voice.go`),
- `voice_leave` → `handleVoiceLeave` (`handlers_voice.go`).

## Approach — port the 3, then delete the V1 machinery

**1. `chat_command` (easiest).** Add `ChatCommandCmd` + a constructor (parses
`channel_id`/`command`/`args`, keeps the `maxCommandArgs` guard) and a
`PluginDeps{PluginRegistry, MessageSvc}` deps struct. The V2 handler returns the
ephemeral `command_reply` via `Result.Reply`; the plugin `Broadcast` becomes a
channel-routed `Result.Events` entry (`plugin_broadcast`) gated by the same
`MessageSvc.CanPost` check it uses today.

**2. `voice_leave`.** Add `VoiceLeaveCmd` + constructor. The V2 handler does the
rate-limit that currently lives in the dispatch wrapper, then signals the leave.
`handleVoiceLeave` **stays** as a hub-internal routine — it is also called
un-throttled on disconnect and channel-switch (`serve.go`, `voice_join.go`), and
those callers must not go through dispatch. The V2 handler expresses its effect
through `Result` (emit the `voice_leave` event + clear the client's voice state),
which needs one small `Result` field for "leave voice" (see below).

**3. `voice_join` (the effort driver).** Add `VoiceJoinCmd` + constructor.
`voice_token_refresh` already proved the LiveKit/KeyHolder deps live in
`VoiceDeps` and that `Reply` + `SetVoiceJoinToken` fit `Result`. `voice_join`
additionally broadcasts `voice_state` (→ `Result.Events`), subscribes the voice
channel topic and sets client voice state (→ new `Result` fields mirroring the
existing `SetChannelID` / `SetVoiceJoinToken` appliers in `handleMessage`), and
persists the DB row. Extend `Result` with the 1–2 missing side-effect fields
rather than inventing a parallel mechanism — the applier switch in
`handleMessage` is already where these mutations run.

**4. Delete V1.** Once all types have a constructor + V2 handler, `handleMessage`
collapses to: parse envelope → `getCommandConstructor(type)` → not found = unknown
type → else `DispatchV2` + apply `Result`. Remove the V1 fallback branch and the
`hasV2` gate; delete `HandlerRegistry.handlers`, `Register`, `Dispatch`,
`IsRegisteredV1`, `RegisteredTypes`, the `MessageHandler` type, and the
V1-shadowing guard inside `RegisterV2`. `registerVoiceHandlersV1` /
`registerPluginCommandHandler` fold into V2 registration in `NewHub`.

## Files touched

- `Server/ws/command.go` — `ChatCommandCmd`, `VoiceJoinCmd`, `VoiceLeaveCmd` +
  constructor registrations.
- `Server/ws/deps.go` — `PluginDeps`; `VoiceDeps` already sufficient.
- `Server/ws/event.go` — extend `Result` with the voice join/leave side-effect
  fields; `plugin_broadcast` channel event.
- `Server/ws/handlers_command.go`, `handlers_voice.go` — V2 handlers; drop V1
  registration functions.
- `Server/ws/handlers.go` — delete V1 fallback + `hasV2` gate; apply new fields.
- `Server/ws/registry.go` — delete the V1 map + methods.
- `Server/ws/hub.go` — `NewHub` registers only V2.
- Docs: `docs/architecture/websocket.md` §D4c (replace dual-dispatch diagram with
  the single typed path), `docs/architecture/server.md` (WS box "V1+V2 dispatch"
  → "typed command dispatch"), `docs/audit-2026-07-19.md` (A-2026-07-09 →
  RESOLVED).

## Test plan

- Add V2 handler tests for `chat_command`, `voice_join`, `voice_leave` (mirror
  the existing `handler_v2_*_test.go` style); assert parse errors, permission
  denials, rate-limit, and the emitted `Result`.
- Keep the existing plugin-command and voice tests green against the V2 path
  (behavior is unchanged); update the few tests that call the deleted V1 registry
  methods.
- A guard test asserting every registered type has a V2 handler and no V1 map
  remains (locks the migration shut so V1 can't creep back).

## Non-goals

- **No wire/protocol change.** The envelope `{type, id, payload}` is identical;
  V1→V2 is a server-internal handler-shape refactor. The client
  (`src/lib/dispatcher.ts`, `ws.send`) is untouched, and neither
  `docs/protocol-schema.json` nor `protocolTypes.ts` changes — `dispatcher.ts`
  only consumes server→client messages, which both dispatch generations emit
  identically.
- Not decomposing the Hub or reworking replay/seq (backlog 12).
- `handleVoiceLeave` remains a hub-internal routine for the disconnect/switch
  callers; only its message _dispatch_ moves to V2.

## As implemented (2026-07-20)

The voice handlers landed with the **applier-trigger** shape rather than a
fully-pure port, because the effect is inseparable from the hub: `handleVoiceJoin`
itself calls `handleVoiceLeave` on a channel switch, and a pure `(cmd, info, deps)`
handler cannot invoke a hub routine. So both symmetric routines stay hub-internal
and the V2 handlers gate parse/rate-limit, then hand off via two new `Result`
side-effect fields the `handleMessage` applier acts on:

- `Result.LeaveVoice bool` → applier runs `h.handleVoiceLeave(c.ctx, c)`
  (matches the design's "one small Result field for leave voice"; the handler
  does the rate-limit that previously lived in the V1 dispatch wrapper).
- `Result.JoinVoice bool` → applier runs `h.handleVoiceJoin(c.ctx, c, env.Payload)`.
  `handleVoiceJoin` is unchanged (keeps its own rate-limit and re-reads the
  already-validated `channel_id`); the `VoiceJoinCmd` constructor is the parse gate.

This keeps `voice_join.go`/`voice_leave.go` and `parseChannelID` (plus their
tests) untouched while still collapsing dispatch to the single typed path and
deleting all V1 machinery. `chat_command` was ported to a genuinely pure V2
handler (`Result.Reply` + a `PluginBroadcastEvent` on `Result.Events`, gated by
`MessageService.CanPost`) as the design described.
