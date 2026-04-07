// Package postgres holds embedded SQL migration files for the PostgreSQL
// backend of the OwnCord server. PostgreSQL is opt-in via the
// `database.type = "postgres"` setting in owncord.yaml.
//
// PostgreSQL migrations are numbered independently from the SQLite migration
// set in Server/migrations/. The two are NOT interchangeable: PostgreSQL
// uses native types (BIGSERIAL, TIMESTAMPTZ, BOOLEAN, tsvector) and a
// consolidated initial schema rather than the historical SQLite migration
// chain.
package postgres

import "embed"

// FS holds all PostgreSQL migration SQL files embedded at compile time.
//
//go:embed *.sql
var FS embed.FS
