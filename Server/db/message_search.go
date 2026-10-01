package db

import (
	"strings"
	"unicode/utf8"
)

// ftsMatchQuery is the MATCH expression for a user's search text: the
// sanitized terms with the last one made a prefix ("deplo" finds "deploy"),
// so a half-typed word still matches. Only the last term — the earlier ones
// were finished when the user typed past them — and only when it has at least
// minPrefixRunes runes: messages_fts has no prefix index, so a one- or
// two-rune prefix would merge a huge range of terms on every keystroke.
// Empty when nothing searchable is left.
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

// minPrefixRunes is the shortest last term ftsMatchQuery makes a prefix.
const minPrefixRunes = 3

// searchPageSQL is the tail of a search query for page: the cursor filter,
// the order and the limit, with their arguments.
func searchPageSQL(page SearchPage) (string, []any) {
	var (
		sb   strings.Builder
		args []any
	)
	if page.Before > 0 {
		sb.WriteString(" AND f.rowid < ?")
		args = append(args, page.Before)
	}
	if page.Recent {
		sb.WriteString(" ORDER BY f.rowid DESC")
	} else {
		sb.WriteString(" ORDER BY rank")
	}
	sb.WriteString(" LIMIT ?")
	return sb.String(), append(args, page.Limit)
}
