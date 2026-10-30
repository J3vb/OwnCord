package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// ErrSearchUnscoped is returned by SearchMessagesFiltered when the query names
// no channel; a search never falls back to "every channel".
var ErrSearchUnscoped = errors.New("search query has no channel scope")

// SearchQuery is one filtered full-text search. Every value reaches SQL as a
// bound argument; only fixed fragments and "?" placeholders are concatenated.
type SearchQuery struct {
	// Text is the raw search words. When nothing searchable survives
	// sanitising it, the query is filter-only: no FTS driver, newest first.
	Text string
	// ChannelIDs is the required, non-empty channel scope.
	ChannelIDs []int64
	// AuthorIDs, when non-empty, keeps messages by any of these users.
	AuthorIDs []int64
	// AfterTS keeps messages with timestamp >= AfterTS; BeforeTS keeps
	// timestamp < BeforeTS. Both use the stored "YYYY-MM-DD HH:MM:SS" UTC
	// format; empty means unbounded.
	AfterTS, BeforeTS string
	// MentionIDs keeps messages that mention every one of these users in
	// their text. Reply-ping rows and @everyone do not count.
	MentionIDs []int64
	// Has keeps messages that satisfy every kind: link, file, image, video,
	// sound. Attachment kinds only see attachments linked to the message.
	Has []string
	// Pinned, when set, keeps messages whose pinned flag equals it.
	Pinned *bool
}

// HasSearchTerms reports whether text has anything left to search for once
// sanitised for FTS5.
func HasSearchTerms(text string) bool {
	return ftsMatchQuery(text) != ""
}

// rankCandidateCap bounds how many matches a relevance search ranks. FTS5
// computes BM25 for every match in the corpus (channel_id is not an FTS
// column) when it consumes ORDER BY rank, so relevance ranks only the newest
// rankCandidateCap in-scope hits. A var so a test can lower it; the number is
// also quoted in SearchPage.Recent (models.go) and docs/api.md.
var rankCandidateCap = 2000

// SearchMessagesFiltered runs the one search query builder, excluding deleted
// messages. With searchable words the order is rank (or newest first when
// page.Recent); without words it is newest first, paged by page.Before.
// Relevance is "best of the newest rankCandidateCap matching messages in
// scope": older matches appear only with sort=recent. Below that many hits
// every match is ranked.
func (d *DB) SearchMessagesFiltered(ctx context.Context, q SearchQuery, page SearchPage) ([]MessageSearchResult, error) {
	if len(q.ChannelIDs) == 0 {
		return nil, fmt.Errorf("SearchMessagesFiltered: %w", ErrSearchUnscoped)
	}
	if page.Limit < 1 {
		return []MessageSearchResult{}, nil
	}
	match := ftsMatchQuery(q.Text)
	ranked := match != ""
	byRank := ranked && !page.Recent

	filter, filterArgs, err := d.searchFilters(ctx, q, ranked)
	if err != nil {
		return nil, fmt.Errorf("SearchMessagesFiltered: %w", err)
	}

	var (
		sb   strings.Builder
		args []any
	)
	sb.WriteString(`SELECT m.id, m.channel_id, c.name, u.id, u.username, u.avatar, m.content,
		        m.timestamp, m.mentions_everyone
		 FROM `)
	idCol := "m.id"
	switch {
	case byRank:
		// CROSS JOIN pins FTS as the driver; the planner otherwise starts from
		// messages and runs a MATCH per row.
		idCol = "f.rowid"
		sb.WriteString("messages_fts f CROSS JOIN messages m ON f.rowid = m.id")
	case ranked:
		idCol = "f.rowid"
		sb.WriteString("messages_fts f JOIN messages m ON f.rowid = m.id")
	default:
		sb.WriteString("messages m")
	}
	sb.WriteString(` JOIN channels c ON m.channel_id = c.id
		 JOIN users u ON m.user_id = u.id
		 WHERE m.deleted = 0 AND m.kind = 0`)
	if ranked {
		sb.WriteString(" AND messages_fts MATCH ?")
		args = append(args, match)
	}
	sb.WriteString(filter)
	args = append(args, filterArgs...)
	if byRank {
		cutoff, ok, cerr := d.rankCutoff(ctx, match, filter, filterArgs)
		if cerr != nil {
			return nil, fmt.Errorf("SearchMessagesFiltered: %w", cerr)
		}
		if ok {
			sb.WriteString(" AND f.rowid >= ?")
			args = append(args, cutoff)
		}
	}
	tail, tailArgs := searchPageSQL(page, idCol, ranked)
	sb.WriteString(tail)
	args = append(args, tailArgs...)

	rows, err := d.reader.QueryContext(ctx, sb.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("SearchMessagesFiltered: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	results, err := scanSearchResults(rows, "SearchMessagesFiltered")
	if err != nil {
		return nil, err
	}
	results, err = d.attachSearchMentions(ctx, results)
	if err != nil {
		return nil, err
	}
	return d.attachSearchStickers(ctx, results)
}

// searchFilters renders the channel, author, date, has:, mentions: and pinned:
// predicates as " AND ..." fragments over alias m (and f when ranked) with
// their bound arguments. It runs once per search so the date bounds probe the
// id range once. With an FTS driver the date bounds go on f.rowid, which FTS5
// takes as a rowid range; SQLite does not carry an m.id bound across the join.
func (d *DB) searchFilters(ctx context.Context, q SearchQuery, ranked bool) (string, []any, error) {
	idCol := "m.id"
	if ranked {
		idCol = "f.rowid"
	}
	var (
		sb   strings.Builder
		args []any
	)
	imported, err := d.importedChannelIDs(ctx)
	if err != nil {
		return "", nil, err
	}
	native, importedInScope := splitImportedScope(q.ChannelIDs, imported)
	sb.WriteString(" AND m.channel_id IN (" + placeholders(len(q.ChannelIDs)) + ")")
	args = appendIDs(args, q.ChannelIDs)
	if len(q.AuthorIDs) > 0 {
		sb.WriteString(" AND m.user_id IN (" + placeholders(len(q.AuthorIDs)) + ")")
		args = appendIDs(args, q.AuthorIDs)
	}
	if q.AfterTS != "" {
		lo, err := d.firstIDAtOrAfter(ctx, q.AfterTS)
		if err != nil {
			return "", nil, err
		}
		bound, boundArgs := idBound(idCol+" >=", lo, native, importedInScope)
		sb.WriteString(bound + " AND m.timestamp >= ?")
		args = append(args, boundArgs...)
		args = append(args, q.AfterTS)
	}
	if q.BeforeTS != "" {
		hi, err := d.firstIDAtOrAfter(ctx, q.BeforeTS)
		if err != nil {
			return "", nil, err
		}
		bound, boundArgs := idBound(idCol+" <", hi, native, importedInScope)
		sb.WriteString(bound + " AND m.timestamp < ?")
		args = append(args, boundArgs...)
		args = append(args, q.BeforeTS)
	}
	extra, extraArgs, err := searchExtraFilters(q)
	if err != nil {
		return "", nil, err
	}
	sb.WriteString(extra)
	return sb.String(), append(args, extraArgs...), nil
}

// rankCutoff returns the rowid of the rankCandidateCap-th newest in-scope hit;
// ok is false when fewer exist, meaning every match is ranked. No channels or
// users join is needed: filter references only m and its own subquery aliases.
func (d *DB) rankCutoff(ctx context.Context, match, filter string, filterArgs []any) (cutoff int64, ok bool, err error) {
	query := `SELECT f.rowid FROM messages_fts f CROSS JOIN messages m ON f.rowid = m.id
		 WHERE m.deleted = 0 AND m.kind = 0 AND messages_fts MATCH ?` + filter +
		` ORDER BY f.rowid DESC LIMIT 1 OFFSET ?`
	args := make([]any, 0, len(filterArgs)+2)
	args = append(args, match)
	args = append(args, filterArgs...)
	args = append(args, rankCandidateCap-1)
	switch err := d.reader.QueryRowContext(ctx, query, args...).Scan(&cutoff); {
	case errors.Is(err, sql.ErrNoRows):
		return 0, false, nil
	case err != nil:
		return 0, false, fmt.Errorf("rankCutoff: %w", err)
	}
	return cutoff, true, nil
}

// importedChannelIDs lists every channel an import built or is building,
// whatever the job's state: even a running import's committed chunks carry old
// dates under new ids, so ids there do not follow time.
func (d *DB) importedChannelIDs(ctx context.Context) ([]int64, error) {
	rows, err := d.reader.QueryContext(ctx, `SELECT channel_id FROM import_jobs WHERE channel_id IS NOT NULL`)
	if err != nil {
		return nil, fmt.Errorf("importedChannelIDs: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("importedChannelIDs scan: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("importedChannelIDs: %w", err)
	}
	return ids, nil
}

// splitImportedScope divides the scope into channels whose ids follow time and
// channels an import built; with none imported, native is the whole scope.
func splitImportedScope(scope, imported []int64) (native, importedInScope []int64) {
	if len(imported) == 0 {
		return scope, nil
	}
	isImported := make(map[int64]bool, len(imported))
	for _, id := range imported {
		isImported[id] = true
	}
	for _, id := range scope {
		if isImported[id] {
			importedInScope = append(importedInScope, id)
		} else {
			native = append(native, id)
		}
	}
	return native, importedInScope
}

// idBound renders one side of a date bound as an id range. Imported channels
// skip the range (their rows are judged by timestamp alone) so native channels
// keep their id range scan; with none in scope it is the plain range.
func idBound(cmp string, bound int64, native, importedInScope []int64) (string, []any) {
	if len(importedInScope) == 0 {
		return " AND " + cmp + " ?", []any{bound}
	}
	imp := appendIDs(nil, importedInScope)
	imports := "m.channel_id IN (" + placeholders(len(importedInScope)) + ")"
	if len(native) == 0 {
		return " AND " + imports, imp
	}
	args := appendIDs(nil, native)
	args = append(args, bound)
	args = append(args, imp...)
	return " AND ((m.channel_id IN (" + placeholders(len(native)) + ") AND " + cmp + " ?) OR " + imports + ")", args
}

// firstIDAtOrAfter returns an id b such that every message with id < b has a
// timestamp before ts and every message with id >= b may qualify. It
// binary-searches messages.id (monotonic with timestamp on every native insert
// path; imported channels are left out) in about 2x20 rowid probes, turning a
// date bound into an id range scan with no timestamp index. The caller still
// applies the exact timestamp predicate, so there are no false positives; a
// backward clock step can hide rows near a bound (accepted). Hard-deleted id
// gaps are skipped by probing for the first existing id at or above each
// midpoint.
func (d *DB) firstIDAtOrAfter(ctx context.Context, ts string) (int64, error) {
	imported, err := d.importedChannelIDs(ctx)
	if err != nil {
		return 0, err
	}
	where, whereArgs := "", []any(nil)
	if len(imported) > 0 {
		where, whereArgs = " AND channel_id NOT IN ("+placeholders(len(imported))+")", appendIDs(nil, imported)
	}
	var minID, maxID sql.NullInt64
	for _, end := range []struct {
		order string
		dst   *sql.NullInt64
	}{{"ASC", &minID}, {"DESC", &maxID}} {
		err := d.reader.QueryRowContext(ctx,
			`SELECT id FROM messages WHERE 1 = 1`+where+` ORDER BY id `+end.order+` LIMIT 1`, whereArgs...).Scan(end.dst)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return 0, fmt.Errorf("firstIDAtOrAfter bounds: %w", err)
		}
		end.dst.Valid = err == nil
	}
	if !minID.Valid || !maxID.Valid {
		return 0, nil
	}
	lo, hi := minID.Int64, maxID.Int64+1
	for lo < hi {
		mid := lo + (hi-lo)/2
		var id int64
		var rowTS string
		err := d.reader.QueryRowContext(ctx,
			`SELECT id, timestamp FROM messages WHERE id >= ?`+where+` ORDER BY id LIMIT 1`,
			append([]any{mid}, whereArgs...)...).Scan(&id, &rowTS)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			hi = mid
		case err != nil:
			return 0, fmt.Errorf("firstIDAtOrAfter probe: %w", err)
		case rowTS >= ts:
			hi = mid
		default:
			lo = id + 1
		}
	}
	return lo, nil
}

// allChannelIDs lists every channel id, for the legacy unscoped SearchMessages.
func (d *DB) allChannelIDs(ctx context.Context) ([]int64, error) {
	rows, err := d.reader.QueryContext(ctx, `SELECT id FROM channels WHERE import_pending = 0`)
	if err != nil {
		return nil, fmt.Errorf("allChannelIDs: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("allChannelIDs scan: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("allChannelIDs rows: %w", err)
	}
	return ids, nil
}

// placeholders returns n comma-separated "?" markers.
func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?,", n-1) + "?"
}

func appendIDs(args []any, ids []int64) []any {
	for _, id := range ids {
		args = append(args, id)
	}
	return args
}
