# `protocol/`

The cross-component WebSocket contract. It lives at the repository root
because neither side owns it: `schema.json` is the single source of truth for
the message-type constants **both** the Go server and the TypeScript client
compile against.

| File          | Role                                                      |
| ------------- | --------------------------------------------------------- |
| `schema.json` | Source of truth. Every wire message type, both directions |

Two files are generated from it and must never be hand-edited:

- `Server/ws/message_types.go`
- `Client/src/lib/protocolTypes.ts`

## Changing the protocol

Edit `schema.json`, then regenerate both consumers with one command from the
repository root:

```bash
npm run generate
```

(Equivalently, `make protocol-generate` or `go run ./cmd/genprotocol` from
`Server/` — the generator is a Go program, so it lives where the Go toolchain
already runs.)

Three gates reject a stale regeneration and one gate checks the schema against
the constants independently — `.githooks/pre-commit`, `make protocol-verify` in
CI, `npm run check:server`, and `Server/ws/protocol_contract_test.go`. There is
nothing extra to run.

The narrative protocol reference is [`docs/protocol.md`](../docs/protocol.md);
the blueprint is [`docs/architecture/websocket.md`](../docs/architecture/websocket.md).
