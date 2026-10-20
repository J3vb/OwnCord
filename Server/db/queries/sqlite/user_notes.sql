-- user_notes holds one private note per (owner, target) (migration 069, WP 6.11a).
-- Keep this file ASCII-only: sqlc v1.30 truncates the next query by the
-- byte/rune difference of any multi-byte character.

-- name: GetUserNote :one
SELECT note FROM user_notes WHERE owner_id = sqlc.arg(owner_id) AND target_id = sqlc.arg(target_id);

-- name: UpsertUserNote :execrows
-- One statement: the target must still exist, so a note is never written for
-- an erased account. Rows affected 0 means the target is gone.
INSERT INTO user_notes (owner_id, target_id, note)
SELECT sqlc.arg(owner_id), u.id, sqlc.arg(note) FROM users u WHERE u.id = sqlc.arg(target_id)
ON CONFLICT (owner_id, target_id) DO UPDATE
   SET note = excluded.note, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');

-- name: DeleteUserNote :exec
DELETE FROM user_notes WHERE owner_id = sqlc.arg(owner_id) AND target_id = sqlc.arg(target_id);
