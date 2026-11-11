package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
)

// readStmtCache holds prepared statements for hot read queries on the reader pool;
// the driver has no cache, so a plain QueryContext re-parses each call (~40 % of CPU
// for a history page). Keyed by SQL text, so only few-spelling SQL belongs: IN lists
// bind ids as one JSON array (idsJSON), sqlc slices pad to a bucket (padIDs). Past
// maxReadStmts entries a query runs unprepared.
type readStmtCache struct {
	mu     sync.Mutex
	stmts  map[string]*sql.Stmt
	closed bool
}

const maxReadStmts = 256

// maxPaddedIDs is the largest bucket padIDs pads to, covering a full pinned list; SQL
// with more placeholders is one-off and never cached.
const maxPaddedIDs = 1024

var errStmtCacheClosed = errors.New("read statement cache closed")

// stmt returns the prepared statement for query, preparing it once, or nil when full
// or the SQL has too many placeholders; the prepare waits for a pool connection, so it
// runs outside mu.
func (c *readStmtCache) stmt(ctx context.Context, pool *sql.DB, query string) (*sql.Stmt, error) {
	if strings.Count(query, "?") > maxPaddedIDs {
		return nil, nil
	}
	c.mu.Lock()
	s, ok := c.stmts[query]
	closed, full := c.closed, len(c.stmts) >= maxReadStmts
	c.mu.Unlock()
	switch {
	case closed:
		return nil, errStmtCacheClosed
	case ok:
		return s, nil
	case full:
		return nil, nil
	}
	prepared, err := pool.PrepareContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("prepare: %w", err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errors.Join(errStmtCacheClosed, prepared.Close())
	}
	if s, ok := c.stmts[query]; ok {
		if err := prepared.Close(); err != nil {
			return nil, fmt.Errorf("close duplicate statement: %w", err)
		}
		return s, nil
	}
	if len(c.stmts) >= maxReadStmts {
		if err := prepared.Close(); err != nil {
			return nil, fmt.Errorf("close statement past the cap: %w", err)
		}
		return nil, nil
	}
	if c.stmts == nil {
		c.stmts = make(map[string]*sql.Stmt)
	}
	c.stmts[query] = prepared
	return prepared, nil
}

func (c *readStmtCache) close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	errs := make([]error, 0, len(c.stmts))
	for _, s := range c.stmts {
		errs = append(errs, s.Close())
	}
	c.stmts = nil
	return errors.Join(errs...)
}

// query runs a read-only query on pool through a cached statement, or unprepared once
// the cache is full.
func (c *readStmtCache) query(ctx context.Context, pool *sql.DB, query string, args ...any) (*sql.Rows, error) {
	s, err := c.stmt(ctx, pool, query)
	if err != nil {
		return nil, err
	}
	var rows *sql.Rows
	if s == nil {
		rows, err = pool.QueryContext(ctx, query, args...)
	} else {
		rows, err = s.QueryContext(ctx, args...)
	}
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	return rows, nil
}

func (d *DB) queryCached(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return d.readStmts.query(ctx, d.reader, query, args...)
}

type cachedReadsKey struct{}

// withCachedReads marks ctx so sqlc reads under it use the statement cache; only code
// whose reads are constant or padded with padIDs may set it.
func withCachedReads(ctx context.Context) context.Context {
	return context.WithValue(ctx, cachedReadsKey{}, true)
}

func cachedReads(ctx context.Context) bool {
	on, _ := ctx.Value(cachedReadsKey{}).(bool)
	return on
}

// padIDs pads ids to the next size bucket by repeating the last id, so a sqlc slice
// query has a handful of SQL spellings; a repeat does not change what IN matches.
func padIDs[T any](ids []T) []T {
	n := len(ids)
	if n == 0 {
		return ids
	}
	size := 8
	for size < n {
		size *= 2
	}
	if size == n || size > maxPaddedIDs {
		return ids
	}
	out := make([]T, size)
	copy(out, ids)
	for i := n; i < size; i++ {
		out[i] = ids[n-1]
	}
	return out
}

func idsJSON(ids []int64) string {
	var sb strings.Builder
	sb.Grow(len(ids)*8 + 2)
	sb.WriteByte('[')
	for i, id := range ids {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(strconv.FormatInt(id, 10))
	}
	sb.WriteByte(']')
	return sb.String()
}
