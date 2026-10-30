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

// readStmtCache holds prepared statements for hot read queries on the reader
// pool. The SQLite driver keeps no statement cache, so a plain QueryContext
// parses and plans its SQL on every call; for a history page that parse was
// about 40 % of the CPU. The cache is keyed by SQL text, so only SQL with a
// small number of spellings belongs here: a hand-written IN list binds its ids
// as one JSON array (idsJSON), and a sqlc slice is padded to a size bucket
// (padIDs). Past maxReadStmts entries a query runs unprepared instead.
type readStmtCache struct {
	mu     sync.Mutex
	stmts  map[string]*sql.Stmt
	closed bool
}

const maxReadStmts = 256

var errStmtCacheClosed = errors.New("read statement cache closed")

// stmt returns the prepared statement for query, preparing it once, or nil
// when the cache is full. database/sql re-prepares it on each reader
// connection that runs it.
func (c *readStmtCache) stmt(ctx context.Context, pool *sql.DB, query string) (*sql.Stmt, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errStmtCacheClosed
	}
	if s, ok := c.stmts[query]; ok {
		return s, nil
	}
	if len(c.stmts) >= maxReadStmts {
		return nil, nil
	}
	s, err := pool.PrepareContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("prepare: %w", err)
	}
	if c.stmts == nil {
		c.stmts = make(map[string]*sql.Stmt)
	}
	c.stmts[query] = s
	return s, nil
}

// close closes every cached statement; later lookups fail.
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

// query runs a read-only query on pool through a cached prepared statement,
// or unprepared once the cache is full.
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

// queryCached runs a read-only query with few SQL spellings on the reader
// through a cached prepared statement.
func (d *DB) queryCached(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return d.readStmts.query(ctx, d.reader, query, args...)
}

type cachedReadsKey struct{}

// withCachedReads marks ctx so the sqlc read queries run under it use the
// statement cache. Only code whose sqlc reads are constant or padded with
// padIDs may set it.
func withCachedReads(ctx context.Context) context.Context {
	return context.WithValue(ctx, cachedReadsKey{}, true)
}

func cachedReads(ctx context.Context) bool {
	on, _ := ctx.Value(cachedReadsKey{}).(bool)
	return on
}

// padIDs pads ids to the next size bucket by repeating the last id, so a sqlc
// slice query has a handful of SQL spellings instead of one per length. A
// repeated value does not change what IN matches.
func padIDs[T any](ids []T) []T {
	n := len(ids)
	if n == 0 {
		return ids
	}
	size := 8
	for size < n {
		size *= 2
	}
	if size == n || size > 256 {
		return ids
	}
	out := make([]T, size)
	copy(out, ids)
	for i := n; i < size; i++ {
		out[i] = ids[n-1]
	}
	return out
}

// idsJSON encodes ids as a JSON array for `IN (SELECT value FROM json_each(?))`,
// which keeps the SQL text the same for any number of ids.
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
