---
paths:
  - "protocol/schema.json"
  - "Server/cmd/genprotocol/**"
---

# Protocol message types

`protocol/schema.json` is the source of truth for the WebSocket message types.
Invoke the `protocol-change` skill before changing it.

`Server/ws/message_types.go` and `Client/src/lib/protocolTypes.ts` are generated
from it and are denied to Edit/Write in `.claude/settings.json`. After a change,
regenerate and stage both files:

```
cd Server && go run ./cmd/genprotocol
```

The pre-commit hook and CI (`make protocol-verify`) both fail on drift.
