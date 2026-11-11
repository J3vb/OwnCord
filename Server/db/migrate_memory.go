package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
)

// A fresh in-memory database used to run every migration on each Migrate
// (about a second per call under the race detector, dominating CI). A fresh
// private ":memory:" database instead receives a copy of one migrated image
// built once per process by the same migration path. File databases and
// shared-cache memory URIs never take this path (a copy would detach a
// shared-cache connection), so production always runs the migrations.
// Differences, neither read today: schema_versions.applied_at is the image's
// build time, and the copy is an SQLite memdb capped at 1 GiB.

type rawSerializer interface{ Serialize() ([]byte, error) }
type rawDeserializer interface{ Deserialize(buf []byte) error }

var freshMemoryImage struct {
	once sync.Once
	img  []byte
	err  error
}

// migratedMemoryImage returns the serialized in-memory image with every migration
// applied; callers must not modify it.
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

// restoreFreshMemory copies the migrated image into an empty in-memory database.
// It reports false when ineligible or the copy failed, leaving database
// untouched so the caller runs the migrations and reports any real error.
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
	// Deserialize resets per-schema PRAGMAs to defaults, so openMemory's set is
	// applied again; a failure leaves a correct database with default tuning. Runs on the
	// pinned connection.
	for _, p := range memoryPragmas {
		if _, err := conn.ExecContext(ctx, p.stmt); err != nil {
			break
		}
	}
	return true
}

// memoryPragmas is filePragmas' set, Exec'd because there is one connection;
// journal_mode is a no-op for :memory: but kept for symmetry.
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
