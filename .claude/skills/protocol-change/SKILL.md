---
name: protocol-change
description: Add or change a WebSocket message type in OwnCord. Use before editing docs/protocol-schema.json, Server/ws/message_types.go, or Client/src/lib/protocolTypes.ts.
---

# protocol-change

`docs/protocol-schema.json` is the source of truth. Both constant files are
generated from it by `Server/scripts/genprotocol/`.

1. Edit `docs/protocol-schema.json`.
2. Run `make protocol-generate` from `Server/`.
3. Commit **both** outputs — `Server/ws/message_types.go` and
   `Client/src/lib/protocolTypes.ts`. One run regenerates the
   pair; committing only the Go side is the usual mistake, and CI's
   `make protocol-verify` fails on either being stale.

Document the semantics in `docs/protocol.md` — the schema carries names and
shapes, not behaviour.

Adding a message type is not enough to make it work: a server handler must be
registered in the `ws` V1/V2 dispatch tables, and the client needs a
`ws.on(...)` subscription in `Client/src/lib/dispatcher.ts`.
