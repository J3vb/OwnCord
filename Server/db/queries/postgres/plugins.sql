-- name: InstallPlugin :one
INSERT INTO plugins (name, version, manifest_json)
VALUES ($1, $2, $3)
ON CONFLICT (name) DO UPDATE
   SET version = excluded.version,
       manifest_json = excluded.manifest_json
RETURNING id;

-- name: EnablePlugin :exec
UPDATE plugins SET enabled = TRUE WHERE id = $1;

-- name: DisablePlugin :exec
UPDATE plugins SET enabled = FALSE WHERE id = $1;

-- name: UninstallPlugin :exec
DELETE FROM plugins WHERE id = $1;

-- name: GetPlugin :one
SELECT id, name, version, enabled, manifest_json, installed_at FROM plugins WHERE id = $1;

-- name: GetPluginByName :one
SELECT id, name, version, enabled, manifest_json, installed_at FROM plugins WHERE name = $1;

-- name: ListPlugins :many
SELECT id, name, version, enabled, manifest_json, installed_at FROM plugins ORDER BY name;

-- name: PluginKVGet :one
SELECT value FROM plugin_kv WHERE plugin_id = $1 AND key = $2;

-- name: PluginKVSet :exec
INSERT INTO plugin_kv (plugin_id, key, value)
VALUES ($1, $2, $3)
ON CONFLICT (plugin_id, key) DO UPDATE SET value = excluded.value;

-- name: PluginKVDelete :exec
DELETE FROM plugin_kv WHERE plugin_id = $1 AND key = $2;
