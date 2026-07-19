---
name: protocol-change
description: Workflow for changing the OwnCord WebSocket protocol (message types, payloads). Use whenever adding/renaming/removing a WS message type or touching docs/protocol-schema.json, Server/ws/message_types.go, or Client src/lib/protocolTypes.ts.
---

# protocol-change — WS protocol workflow

`docs/protocol-schema.json` is the **single source of truth** for WS message-type constants. `Server/ws/message_types.go` and `Client/tauri-client/src/lib/protocolTypes.ts` are generated from it — never edit those two files by hand.

## Steps

1. Edit `docs/protocol-schema.json` (add/rename the message type).
2. Regenerate both sides:
   ```bash
   cd Server && make protocol-generate
   ```
3. Implement the behavior:
   - Server: handler/dispatch in `Server/ws/`, plus any REST or db work.
   - Client: handling in the client's WS layer using the generated constants from `src/lib/protocolTypes.ts`.
4. Update the human-readable protocol doc `docs/protocol.md` to match.
5. Verify nothing is stale: `cd Server && make protocol-verify` (CI runs this and fails on drift).
6. Commit the schema, both generated files, and the doc together in one commit.

## Notes

- Keep changes backward-compatible where possible — old clients may be connected during rolling updates; note breaking changes in `CHANGELOG.md`.
- Add/extend tests on both sides: Go tests in `Server/ws/`, client tests under `tests/` (new tests must pass; the legacy unit suite is KNOWN RED — see the ci-check skill).
