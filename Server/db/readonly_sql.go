package db

import (
	"context"
	"database/sql"
	"strings"
)

// dbtx routes statements between the reader and writer pools for sqlc's DBTX.
// ExecContext and PrepareContext go to the writer; QueryContext/QueryRowContext
// go to the reader only when isReadOnlySQL proves the statement read-only, since
// sqlc routes INSERT/UPDATE/DELETE ... RETURNING through them. In-memory
// databases have writer == reader.
type dbtx struct {
	writer *sql.DB
	reader *sql.DB
	stmts  *readStmtCache
}

func (t *dbtx) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return t.writer.ExecContext(ctx, query, args...)
}

func (t *dbtx) PrepareContext(ctx context.Context, query string) (*sql.Stmt, error) {
	return t.writer.PrepareContext(ctx, query)
}

func (t *dbtx) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	pool := t.pool(query)
	if t.stmts != nil && cachedReads(ctx) && isReadOnlySQL(query) {
		return t.stmts.query(ctx, pool, query, args...)
	}
	return pool.QueryContext(ctx, query, args...)
}

func (t *dbtx) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return t.pool(query).QueryRowContext(ctx, query, args...)
}

func (t *dbtx) pool(query string) *sql.DB {
	if isReadOnlySQL(query) {
		return t.reader
	}
	return t.writer
}

// isReadOnlySQL reports whether the leading keyword, after whitespace and `--`
// comments (sqlc SQL starts with `-- name: ...`), is SELECT or PRAGMA, or WITH with no
// write keyword (a CTE can lead a write). Anything unrecognized, including `/* */`, is
// a write.
func isReadOnlySQL(query string) bool {
	s := query
	for {
		s = strings.TrimLeft(s, " \t\r\n")
		if !strings.HasPrefix(s, "--") {
			break
		}
		nl := strings.IndexByte(s, '\n')
		if nl < 0 {
			return false // comment-only "statement" — let the writer reject it
		}
		s = s[nl+1:]
	}
	if hasKeywordPrefix(s, "WITH") {
		return !hasWriteKeyword(s)
	}
	return hasKeywordPrefix(s, "SELECT") || hasKeywordPrefix(s, "PRAGMA")
}

// writeKeywords make a WITH statement a write; RETURNING is listed so an unusual write
// shape lands on the writer.
var writeKeywords = [...]string{"INSERT", "UPDATE", "DELETE", "REPLACE", "RETURNING"}

// hasWriteKeyword reports whether any whole word of s (ASCII case-insensitive)
// is a write keyword. Words in literals and comments count too: a false hit only costs speed.
func hasWriteKeyword(s string) bool {
	start := -1
	for i := 0; i <= len(s); i++ {
		if i < len(s) && isIdentByte(s[i]) {
			if start < 0 {
				start = i
			}
			continue
		}
		if start >= 0 {
			word := s[start:i]
			for _, kw := range writeKeywords {
				if strings.EqualFold(word, kw) {
					return true
				}
			}
			start = -1
		}
	}
	return false
}

func isIdentByte(c byte) bool {
	return c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// hasKeywordPrefix reports whether s starts with keyword followed by a non-identifier
// character or end of input.
func hasKeywordPrefix(s, keyword string) bool {
	if len(s) < len(keyword) || !strings.EqualFold(s[:len(keyword)], keyword) {
		return false
	}
	if len(s) == len(keyword) {
		return true
	}
	return !isIdentByte(s[len(keyword)])
}
