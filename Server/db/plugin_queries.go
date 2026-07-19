package db

import (
	"context"
	"fmt"
)

// ── Plugin persistence (Phase C Step 9) ─────────────────────────────────────
//
// Moved verbatim from the store package's SQLiteStore (D3). The SQL is
// unchanged.

func (d *DB) InstallPlugin(ctx context.Context, name, version, manifestJSON string) (int64, error) {
	res, err := d.sqlDB.ExecContext(ctx,
		`INSERT INTO plugins (name, version, enabled, manifest_json) VALUES (?, ?, 0, ?)
		 ON CONFLICT(name) DO UPDATE SET version = excluded.version, manifest_json = excluded.manifest_json`,
		name, version, manifestJSON,
	)
	if err != nil {
		return 0, fmt.Errorf("InstallPlugin: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil || id == 0 {
		// On conflict path LastInsertId may be 0; look up by name.
		row := d.sqlDB.QueryRowContext(ctx, `SELECT id FROM plugins WHERE name = ?`, name)
		if scanErr := row.Scan(&id); scanErr != nil {
			return 0, fmt.Errorf("InstallPlugin lookup: %w", scanErr)
		}
	}
	return id, nil
}

func (d *DB) EnablePlugin(ctx context.Context, id int64) error {
	_, err := d.sqlDB.ExecContext(ctx, `UPDATE plugins SET enabled = 1 WHERE id = ?`, id)
	return err
}

func (d *DB) DisablePlugin(ctx context.Context, id int64) error {
	_, err := d.sqlDB.ExecContext(ctx, `UPDATE plugins SET enabled = 0 WHERE id = ?`, id)
	return err
}

func (d *DB) UninstallPlugin(ctx context.Context, id int64) error {
	_, err := d.sqlDB.ExecContext(ctx, `DELETE FROM plugins WHERE id = ?`, id)
	return err
}

func (d *DB) GetPlugin(ctx context.Context, id int64) (*PluginRow, error) {
	row := d.sqlDB.QueryRowContext(ctx,
		`SELECT id, name, version, enabled, manifest_json, installed_at FROM plugins WHERE id = ?`,
		id,
	)
	return scanPluginRow(row)
}

func (d *DB) GetPluginByName(ctx context.Context, name string) (*PluginRow, error) {
	row := d.sqlDB.QueryRowContext(ctx,
		`SELECT id, name, version, enabled, manifest_json, installed_at FROM plugins WHERE name = ?`,
		name,
	)
	return scanPluginRow(row)
}

func (d *DB) ListPlugins(ctx context.Context) ([]PluginRow, error) {
	rows, err := d.sqlDB.QueryContext(ctx,
		`SELECT id, name, version, enabled, manifest_json, installed_at FROM plugins ORDER BY name`,
	)
	if err != nil {
		return nil, fmt.Errorf("ListPlugins: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []PluginRow
	for rows.Next() {
		var p PluginRow
		var enabledInt int64
		var installedAt string
		if err := rows.Scan(&p.ID, &p.Name, &p.Version, &enabledInt, &p.ManifestJSON, &installedAt); err != nil {
			return nil, fmt.Errorf("ListPlugins scan: %w", err)
		}
		p.Enabled = enabledInt != 0
		p.InstalledAt = parseSQLiteTime(installedAt)
		out = append(out, p)
	}
	return out, rows.Err()
}

func (d *DB) PluginKVGet(ctx context.Context, pluginID int64, key string) ([]byte, error) {
	row := d.sqlDB.QueryRowContext(ctx,
		`SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?`,
		pluginID, key,
	)
	var v []byte
	if err := row.Scan(&v); err != nil {
		return nil, err
	}
	return v, nil
}

func (d *DB) PluginKVSet(ctx context.Context, pluginID int64, key string, value []byte) error {
	_, err := d.sqlDB.ExecContext(ctx,
		`INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?, ?, ?)
		 ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value`,
		pluginID, key, value,
	)
	return err
}

func (d *DB) PluginKVDelete(ctx context.Context, pluginID int64, key string) error {
	_, err := d.sqlDB.ExecContext(ctx,
		`DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?`,
		pluginID, key,
	)
	return err
}

func (d *DB) PluginKVScan(ctx context.Context, pluginID int64, prefix string, limit int) (map[string][]byte, error) {
	rows, err := d.sqlDB.QueryContext(ctx,
		`SELECT key, value FROM plugin_kv WHERE plugin_id = ? AND key LIKE ? ORDER BY key LIMIT ?`,
		pluginID, prefix+"%", limit,
	)
	if err != nil {
		return nil, fmt.Errorf("PluginKVScan: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make(map[string][]byte)
	for rows.Next() {
		var k string
		var v []byte
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// rowScanner is satisfied by *sql.Row and *sql.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanPluginRow(row rowScanner) (*PluginRow, error) {
	var p PluginRow
	var enabledInt int64
	var installedAt string
	if err := row.Scan(&p.ID, &p.Name, &p.Version, &enabledInt, &p.ManifestJSON, &installedAt); err != nil {
		return nil, err
	}
	p.Enabled = enabledInt != 0
	p.InstalledAt = parseSQLiteTime(installedAt)
	return &p, nil
}
