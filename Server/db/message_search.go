package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ftsMatchQuery is the MATCH expression for a user's search text: sanitized
// terms with the last one made a prefix ("deplo" finds "deploy"), only when it
// has at least minPrefixRunes runes, since messages_fts has no prefix index and
// a one- or two-rune prefix would merge a huge range of terms on every
// keystroke. Empty when nothing searchable is left.
func ftsMatchQuery(q string) string {
	q = sanitizeFTSQuery(q)
	if q == "" {
		return ""
	}
	if utf8.RuneCountInString(q[strings.LastIndexByte(q, ' ')+1:]) < minPrefixRunes {
		return q
	}
	return q + "*"
}

const minPrefixRunes = 3

// searchPageSQL is the tail of a search query for page: cursor filter, order
// and limit. idCol is the id column of the driving table (f.rowid with a
// MATCH, m.id without); ranked reports an FTS driver. Relevance orders by
// +rank (the unary plus stops FTS5 consuming the ORDER BY, which would score
// every match in the corpus) with the rowid as tie-break.
func searchPageSQL(page SearchPage, idCol string, ranked bool) (string, []any) {
	var (
		sb   strings.Builder
		args []any
	)
	if page.Before > 0 {
		sb.WriteString(" AND " + idCol + " < ?")
		args = append(args, page.Before)
	}
	if page.Recent || !ranked {
		sb.WriteString(" ORDER BY " + idCol + " DESC")
	} else {
		sb.WriteString(" ORDER BY +rank, " + idCol + " DESC")
	}
	sb.WriteString(" LIMIT ?")
	return sb.String(), append(args, page.Limit)
}

// sanitizeFTSQuery strips FTS5 operator characters from user input to prevent
// query injection: letters, digits and spaces pass; every other rune folds to a
// space. Folding, not dropping, keeps punctuation searchable: unicode61
// indexes "user_id" as `user` and `id`, and dropping the underscore would ask
// for `userid`, matching nothing; '-' would introduce a column filter and error.
// Bareword AND, OR and NOT raise "fts5: syntax error" at the ends of a query, so such
// tokens are dropped.
func sanitizeFTSQuery(q string) string {
	var sb strings.Builder
	sb.Grow(len(q))
	for _, r := range q {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			sb.WriteRune(r)
			continue
		}
		// unicode61 keeps the combining diacritics block (U+0300-U+036F) inside the
		// token, so splitting on one would turn NFD "résumé" into "re sume".
		if r >= 0x0300 && r <= 0x036F {
			continue
		}
		// Everything else (separators, FTS5 grammar characters) becomes a separator, keeping
		// operator syntax inert.
		sb.WriteRune(' ')
	}
	result := strings.TrimSpace(sb.String())
	if runes := []rune(result); len(runes) > 200 {
		result = string(runes[:200])
	}

	fields := strings.Fields(result)
	kept := fields[:0]
	for _, f := range fields {
		if f == "AND" || f == "OR" || f == "NOT" {
			continue
		}
		kept = append(kept, f)
	}
	return strings.Join(kept, " ")
}

// SearchMessages runs a full-text search scoped to channelID when non-nil, via
// SearchMessagesFiltered.
func (d *DB) SearchMessages(ctx context.Context, query string, channelID *int64, page SearchPage) ([]MessageSearchResult, error) {
	if !HasSearchTerms(query) {
		return []MessageSearchResult{}, nil
	}
	var channelIDs []int64
	if channelID != nil {
		channelIDs = []int64{*channelID}
	} else {
		all, err := d.allChannelIDs(ctx)
		if err != nil {
			return nil, fmt.Errorf("SearchMessages: %w", err)
		}
		channelIDs = all
	}
	if len(channelIDs) == 0 {
		return []MessageSearchResult{}, nil
	}
	return d.SearchMessagesFiltered(ctx, SearchQuery{Text: query, ChannelIDs: channelIDs}, page)
}

// SearchMessagesInChannels searches only channelIDs at the DB level, so results never
// leak across channels.
func (d *DB) SearchMessagesInChannels(ctx context.Context, query string, channelIDs []int64, page SearchPage) ([]MessageSearchResult, error) {
	if len(channelIDs) == 0 || !HasSearchTerms(query) {
		return []MessageSearchResult{}, nil
	}
	return d.SearchMessagesFiltered(ctx, SearchQuery{Text: query, ChannelIDs: channelIDs}, page)
}

func scanSearchResults(rows *sql.Rows, label string) ([]MessageSearchResult, error) {
	results := []MessageSearchResult{}
	for rows.Next() {
		var r MessageSearchResult
		var everyone int
		if scanErr := rows.Scan(&r.MessageID, &r.ChannelID, &r.ChannelName,
			&r.User.ID, &r.User.Username, &r.User.Avatar,
			&r.Content, &r.Timestamp, &everyone); scanErr != nil {
			return nil, fmt.Errorf("%s scan: %w", label, scanErr)
		}
		r.MentionsEveryone = everyone != 0
		r.Mentions = []int64{}
		results = append(results, r)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("%s rows: %w", label, rows.Err())
	}
	return results, nil
}

func (d *DB) attachSearchMentions(ctx context.Context, results []MessageSearchResult) ([]MessageSearchResult, error) {
	if len(results) == 0 {
		return results, nil
	}
	ids := make([]int64, len(results))
	for i := range results {
		ids[i] = results[i].MessageID
	}
	mentionMap, err := d.GetMentionsByMessageIDs(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("attachSearchMentions: %w", err)
	}
	for i := range results {
		if m, ok := mentionMap[results[i].MessageID]; ok {
			results[i].Mentions = m
		}
	}
	return results, nil
}
