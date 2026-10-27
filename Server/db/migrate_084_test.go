package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// TestMigration084_AddsVoiceColumns: 084 adds duration_ms and waveform to
// attachments, both nullable, and an attachment that existed before it keeps
// every value with both new columns NULL.
func TestMigration084_AddsVoiceColumns(t *testing.T) {
	database := openMemory(t)
	ctx := context.Background()
	if err := db.MigrateFS(database, migrationsUpTo(t, "084_")); err != nil {
		t.Fatalf("MigrateFS up to 083: %v", err)
	}
	for _, col := range []string{"duration_ms", "waveform"} {
		if columnExists(t, database, "attachments", col) {
			t.Fatalf("attachments.%s exists before 084; the test no longer exercises the migration", col)
		}
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO attachments (id, filename, stored_as, mime_type, size) VALUES ('old', 'a.ogg', 'old', 'audio/ogg', 5)`); err != nil {
		t.Fatalf("insert pre-084 attachment: %v", err)
	}

	if err := db.MigrateFS(database, migrationsUpTo(t, "085_")); err != nil {
		t.Fatalf("Migrate 084: %v", err)
	}
	for _, col := range []string{"duration_ms", "waveform"} {
		if !columnExists(t, database, "attachments", col) {
			t.Errorf("attachments.%s missing after 084", col)
		}
	}

	var dur *int64
	var wave *string
	var size int64
	if err := database.QueryRowContext(ctx,
		`SELECT size, duration_ms, waveform FROM attachments WHERE id = 'old'`).Scan(&size, &dur, &wave); err != nil {
		t.Fatalf("read pre-084 attachment: %v", err)
	}
	if size != 5 || dur != nil || wave != nil {
		t.Errorf("pre-084 row = size %d, duration %v, waveform %v; want 5, NULL, NULL", size, dur, wave)
	}

	if _, err := database.ExecContext(ctx,
		`INSERT INTO attachments (id, filename, stored_as, mime_type, size, duration_ms, waveform) VALUES ('new', 'v.ogg', 'new', 'audio/ogg', 9, 1500, 'AQID')`); err != nil {
		t.Fatalf("insert voice attachment: %v", err)
	}
	if err := database.QueryRowContext(ctx,
		`SELECT duration_ms, waveform FROM attachments WHERE id = 'new'`).Scan(&dur, &wave); err != nil {
		t.Fatalf("read voice attachment: %v", err)
	}
	if dur == nil || *dur != 1500 || wave == nil || *wave != "AQID" {
		t.Errorf("voice row = %v, %v; want 1500, AQID", dur, wave)
	}
}
