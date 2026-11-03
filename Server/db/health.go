package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
)

// HealthStats is the database's state for the admin System health page:
// file sizes, the newest applied migration and the two pools' figures. Sizes
// are 0 for an in-memory database.
type HealthStats struct {
	FileBytes       int64
	WALBytes        int64
	SchemaVersion   string
	ReadersInUse    int
	ReadersOpen     int
	ReadersMax      int
	ReaderWaitCount int64
	ReaderWaitMs    float64
	WriterWaitCount int64
	WriterWaitMs    float64
}

// HealthStats reads the figures with one query on the reader pool, so a busy
// writer cannot hold it up; the caller's deadline bounds that query.
func (d *DB) HealthStats(ctx context.Context) (HealthStats, error) {
	out := HealthStats{}
	reader, writer := d.reader.Stats(), d.writer.Stats()
	out.ReadersInUse, out.ReadersOpen, out.ReadersMax = reader.InUse, reader.OpenConnections, reader.MaxOpenConnections
	out.ReaderWaitCount, out.ReaderWaitMs = reader.WaitCount, float64(reader.WaitDuration.Microseconds())/1000
	out.WriterWaitCount, out.WriterWaitMs = writer.WaitCount, float64(writer.WaitDuration.Microseconds())/1000
	if d.walPath != "" {
		fi, err := os.Stat(strings.TrimSuffix(d.walPath, "-wal"))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return out, fmt.Errorf("stat database file: %w", err)
		}
		if err == nil {
			out.FileBytes = fi.Size()
		}
	}
	wal, err := d.WALBytes()
	if err != nil {
		return out, fmt.Errorf("health stats: %w", err)
	}
	out.WALBytes = wal
	var version sql.NullString
	if err := d.reader.QueryRowContext(ctx, "SELECT MAX(version) FROM schema_versions").Scan(&version); err != nil {
		return out, fmt.Errorf("health stats schema version: %w", err)
	}
	out.SchemaVersion = version.String
	return out, nil
}
