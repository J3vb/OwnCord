---
name: protocol-change
description: Add or change a WebSocket message type in OwnCord. Use before editing protocol/schema.json, Server/ws/message_types.go, or Client/src/lib/protocolTypes.ts.
---

# protocol-change

`protocol/schema.json` is the source of truth. Both constant files are
generated from it by `Server/cmd/genprotocol/`.

**The schema holds message-type NAMES only.** Route by what you are changing —
most payload work never touches it, and sending a field change through the
regenerate cycle below is wasted work:

| Change                                                   | What to edit                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| New message type                                         | schema + regenerate (steps below)                                                                                      |
| New or changed payload **field** on an existing type     | `Server/ws/command.go`/`messages.go`, `Client/src/lib/protocolTypes.ts`, `docs/protocol.md` — no schema, no regenerate |
| Content inside an opaque blob the server relays verbatim | `docs/protocol.md` only; often zero Go change                                                                          |

Before assuming a field needs server work, read the relay handler: if the server
forwards the message raw, there is nothing to add. If it **re-serialises**, an
older server drops unknown JSON fields — so a field the server must forward is
NOT backward compatible with older servers.

1. Edit `protocol/schema.json`.
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
