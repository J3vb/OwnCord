-- Phase C Step 9: Wazero plugin runtime.
-- Records installed plugins and their per-plugin KV namespace. The KV store
-- is exposed to plugins via the `storage` host-API capability.
CREATE TABLE IF NOT EXISTS plugins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL UNIQUE,
    version       TEXT    NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 0,
    manifest_json TEXT    NOT NULL,
    installed_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plugin_kv (
    plugin_id INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    key       TEXT    NOT NULL,
    value     BLOB    NOT NULL,
    PRIMARY KEY (plugin_id, key)
);
