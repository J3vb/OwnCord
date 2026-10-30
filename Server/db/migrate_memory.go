package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
)

// A fresh in-memory database used to run every migration on each Migrate,
// about a second per call under the race detector, which dominated CI because
// tests open hundreds. A fresh private ":memory:" database instead receives a
// copy of one migrated image built once per process by the same migration
// path. File databases and shared-cache memory URIs never take this path (a
// copy would detach a shared-cache connection from the cache), so production
// always runs the migrations. Two differences from in-place migration, neither
// read today: schema_versions.applied_at is when the image was built, and the
// copy is an SQLite memdb capped at 1 GiB.

type rawSerializer interface{ Serialize() ([]byte, error) }
type rawDeserializer interface{ Deserialize(buf []byte) error }

var freshMemoryImage struct {
	once sync.Once
	img  []byte
	err  error
}

// migratedMemoryImage returns the serialized image of an in-memory database
// with every embedded migration applied. Callers must not modify it.
func migratedMemoryImage() ([]byte, error) {
	freshMemoryImage.once.Do(func() {
		freshMemoryImage.img, freshMemoryImage.err = buildMigratedMemoryImage()
	})
	return freshMemoryImage.img, freshMemoryImage.err
}

//nolint:contextcheck // Migrate takes no context; this runs once per process on an in-memory database.
func buildMigratedMemoryImage() ([]byte, error) {
	scratch, err := openMemory(":memory:")
	if err != nil {
		return nil, fmt.Errorf("opening scratch database: %w", err)
	}
	defer func() { _ = scratch.Close() }()
	if err := migrateEmbedded(scratch); err != nil {
		return nil, fmt.Errorf("migrating scratch database: %w", err)
	}
	conn, err := scratch.writer.Conn(context.Background())
	if err != nil {
		return nil, fmt.Errorf("pinning scratch connection: %w", err)
	}
	defer func() { _ = conn.Close() }()
	var img []byte
	err = conn.Raw(func(driverConn any) error {
		s, ok := driverConn.(rawSerializer)
		if !ok {
			return errors.New("sqlite driver connection cannot serialize")
		}
		var serr error
		img, serr = s.Serialize()
		return serr
	})
	if err != nil {
		return nil, fmt.Errorf("serializing scratch database: %w", err)
	}
	return img, nil
}

// restoreFreshMemory copies the migrated image into database when it is an
// empty in-memory database. It reports false when database is not eligible or
// the copy could not be made, leaving database untouched so the caller runs the
// migrations itself and reports any real error from them.
//
//nolint:contextcheck // Migrate takes no context; the copy is an in-memory memcpy.
func restoreFreshMemory(database *DB) bool {
	if !database.plainMemory {
		return false
	}
	var objects int
	if err := database.writer.QueryRow("SELECT count(*) FROM sqlite_master").Scan(&objects); err != nil || objects != 0 {
		return false
	}
	img, err := migratedMemoryImage()
	if err != nil {
		return false
	}
	ctx := context.Background()
	conn, err := database.writer.Conn(ctx)
	if err != nil {
		return false
	}
	defer func() { _ = conn.Close() }()
	err = conn.Raw(func(driverConn any) error {
		d, ok := driverConn.(rawDeserializer)
		if !ok {
			return errors.New("sqlite driver connection cannot deserialize")
		}
		return d.Deserialize(img)
	})
	if err != nil {
		return false
	}
	// Deserialize resets the per-schema PRAGMAs (cache_size, synchronous,
	// mmap_size) to defaults, so openMemory's set is applied again. A failure
	// leaves a correct database with default tuning, so the copy stands. It runs on
	// the pinned connection, the only one in the pool.
	for _, p := range memoryPragmas {
		if _, err := conn.ExecContext(ctx, p.stmt); err != nil {
			break
		}
	}
	return true
}

// memoryPragmas is the same PRAGMA set as filePragmas, Exec'd because there is
// exactly one connection to configure. journal_mode is a no-op for :memory:
// (SQLite reports "memory") but is kept for symmetry with file mode.
var memoryPragmas = []struct{ name, stmt string }{
	{"enabling WAL mode", "PRAGMA journal_mode=WAL;"},
	{"setting busy_timeout", "PRAGMA busy_timeout=5000;"},
	{"enabling foreign keys", "PRAGMA foreign_keys=ON;"},
	{"setting synchronous mode", "PRAGMA synchronous=NORMAL;"},
	{"setting temp_store", "PRAGMA temp_store=MEMORY;"},
	{"setting mmap_size", "PRAGMA mmap_size=268435456;"},
	{"setting cache_size", "PRAGMA cache_size=-64000;"},
}

func applyMemoryPragmas(sqlDB *sql.DB) error {
	for _, p := range memoryPragmas {
		if _, err := sqlDB.Exec(p.stmt); err != nil {
			return fmt.Errorf("%s: %w", p.name, err)
		}
	}
	return nil
}
