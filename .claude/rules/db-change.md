---
paths:
  - "Server/db/queries/**"
  - "Server/migrations/**"
  - "Server/sqlc.yaml"
---

# Schema and query edits

These files are the sqlc source of truth. Invoke the `db-change` skill before
changing anything here.

`Server/db/dbgen/` is generated from them and is denied to Edit/Write in
`.claude/settings.json`. After a change, regenerate and stage the result:

```
cd Server && sqlc generate
```

The pre-commit hook and CI (`make sqlc-verify`) both fail on drift.
