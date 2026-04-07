-- name: InstallPlugin :execresult
INSERT INTO plugins (name, version, manifest_json) VALUES (?, ?, ?)
ON CONFLICT(name) DO UPDATE SET version = excluded.version, manifest_json = excluded.manifest_json;

-- name: EnablePlugin :exec
UPDATE plugins SET enabled = 1 WHERE id = ?;

-- name: DisablePlugin :exec
UPDATE plugins SET enabled = 0 WHERE id = ?;

-- name: UninstallPlugin :exec
DELETE FROM plugins WHERE id = ?;

-- name: GetPlugin :one
SELECT id, name, version, enabled, manifest_json, installed_at FROM plugins WHERE id = ?;

-- name: GetPluginByName :one
SELECT id, name, version, enabled, manifest_json, installed_at FROM plugins WHERE name = ?;

-- name: ListPlugins :many
SELECT id, name, version, enabled, manifest_json, installed_at FROM plugins ORDER BY name;

-- name: PluginKVGet :one
SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?;

-- name: PluginKVSet :exec
INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?, ?, ?)
ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value;

-- name: PluginKVDelete :exec
DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?;
