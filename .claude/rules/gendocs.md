---
paths:
  - "Server/api/router.go"
  - "Server/config/config.go"
  - "Server/migrations/**"
---

# Generated documentation blocks

The `gendocs:*` blocks in `docs/api.md`, `docs/schema.md` and
`docs/server-configuration.md` are generated from these files. Never edit
inside a `gendocs:*` block by hand. After changing routes, config fields or
migrations, regenerate and stage the docs:

```
cd Server && go run -tags otel,wazero ./cmd/gendocs
```

CI (`make docs-verify`) fails on drift.
