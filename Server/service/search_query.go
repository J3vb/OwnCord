package service

import (
	"fmt"
	"strings"
	"time"
	"unicode"

	// Embed the IANA zone database so a tz name resolves on hosts that ship
	// none (a Windows server without a Go install).
	_ "time/tzdata"
)

// Limits on filter tokens in one search query (design D12).
const (
	maxSearchFilterTokens = 25
	maxSearchFilterValues = 10
	maxSearchTZLen        = 64

	searchDateLayout = "2006-01-02"
	// searchTSLayout is the stored messages.timestamp format, in UTC.
	searchTSLayout = "2006-01-02 15:04:05"
)

// ParsedSearch is a search query split into free text and typed filters.
type ParsedSearch struct {
	// Text is the free text: the non-filter tokens joined by one space, or the
	// query byte for byte when it holds no filter token at all.
	Text string
	// From and In are the raw usernames and channel names, in order of
	// appearance, with any leading @ or # removed.
	From, In []string
	// AfterTS and BeforeTS are the date bounds as stored UTC timestamps:
	// timestamp >= AfterTS and timestamp < BeforeTS. Empty means unbounded.
	AfterTS, BeforeTS string
	// EmptyRange is set when the date filters intersect to nothing.
	EmptyRange bool
	// HasFilters reports whether any non-empty filter value was given.
	HasFilters bool
}

// searchKey names a filter key active in this version.
func searchKey(k string) (string, bool) {
	switch k {
	case "from", "in", "before", "after", "during":
		return k, true
	}
	return "", false
}

// searchToken is one lexed piece of a query: free text (key == "") or a
// filter with its already-trimmed value.
type searchToken struct {
	key, val string
}

// lexSearch splits q into tokens on Unicode whitespace. A token is a filter
// when it starts with an active key (any case) and a colon; its value is
// either a quoted run (to the next quote, or the end of q) or the rest of the
// whitespace-delimited token. Everything else is one text token.
func lexSearch(q string) []searchToken {
	var toks []searchToken
	rs := []rune(q)
	i := 0
	for i < len(rs) {
		if unicode.IsSpace(rs[i]) {
			i++
			continue
		}
		start := i
		for i < len(rs) && !unicode.IsSpace(rs[i]) && rs[i] != ':' {
			i++
		}
		key, ok := "", false
		if i < len(rs) && rs[i] == ':' {
			key, ok = searchKey(strings.ToLower(string(rs[start:i])))
		}
		if !ok {
			for i < len(rs) && !unicode.IsSpace(rs[i]) {
				i++
			}
			toks = append(toks, searchToken{val: string(rs[start:i])})
			continue
		}
		i++ // the colon
		var val string
		val, i = lexSearchValue(rs, i)
		toks = append(toks, searchToken{key: key, val: cleanSearchValue(key, val)})
	}
	return toks
}

// lexSearchValue reads a filter value from rs[i:] and returns it with the
// index of the first rune after it.
func lexSearchValue(rs []rune, i int) (string, int) {
	vs := i
	if i < len(rs) && rs[i] == '"' {
		i++
		vs = i
		for i < len(rs) && rs[i] != '"' {
			i++
		}
		val := string(rs[vs:i])
		if i < len(rs) {
			i++ // the closing quote
		}
		return val, i
	}
	for i < len(rs) && !unicode.IsSpace(rs[i]) {
		i++
	}
	return string(rs[vs:i]), i
}

// cleanSearchValue trims the optional @ (users) or # (channels) prefix.
func cleanSearchValue(key, val string) string {
	val = strings.TrimSpace(val)
	switch key {
	case "from":
		val = strings.TrimLeft(val, "@")
	case "in":
		val = strings.TrimLeft(val, "#")
	}
	return strings.TrimSpace(val)
}

// ParseSearch splits q into free text and filters. tz is an IANA zone name
// ("" means UTC) that anchors the date filters to local midnight. Unknown
// keys and empty values never fail; a malformed value of a known key, a bad
// tz and too many filters are ErrBadRequest errors naming the culprit.
func ParseSearch(q, tz string) (ParsedSearch, error) {
	loc, err := loadSearchLocation(tz)
	if err != nil {
		return ParsedSearch{}, err
	}
	var (
		p        ParsedSearch
		words    []string
		consumed bool
		tokens   int
		window   searchWindow
	)
	for _, tok := range lexSearch(q) {
		if tok.key == "" {
			words = append(words, tok.val)
			continue
		}
		consumed = true
		if tok.val == "" {
			continue
		}
		tokens++
		if tokens > maxSearchFilterTokens {
			return ParsedSearch{}, fmt.Errorf("%w: too many filters (at most %d)", ErrBadRequest, maxSearchFilterTokens)
		}
		p.HasFilters = true
		switch tok.key {
		case "from":
			p.From = append(p.From, tok.val)
		case "in":
			p.In = append(p.In, tok.val)
		default:
			dLo, dHi, perr := searchDayRange(tok.key, tok.val, loc)
			if perr != nil {
				return ParsedSearch{}, perr
			}
			window.intersect(dLo, dHi)
		}
		if len(p.From) > maxSearchFilterValues || len(p.In) > maxSearchFilterValues {
			return ParsedSearch{}, fmt.Errorf("%w: %s: allows at most %d values", ErrBadRequest, tok.key+":", maxSearchFilterValues)
		}
	}

	if consumed {
		p.Text = strings.Join(words, " ")
	} else {
		p.Text = q
	}
	p.AfterTS, p.BeforeTS, p.EmptyRange = window.stored()
	return p, nil
}

// searchWindow is the running intersection of the date filters; a zero bound
// is unbounded.
type searchWindow struct {
	lo, hi time.Time
}

// intersect narrows the window to also satisfy [lo, hi).
func (w *searchWindow) intersect(lo, hi time.Time) {
	if !lo.IsZero() && (w.lo.IsZero() || lo.After(w.lo)) {
		w.lo = lo
	}
	if !hi.IsZero() && (w.hi.IsZero() || hi.Before(w.hi)) {
		w.hi = hi
	}
}

// stored renders the bounds as stored UTC timestamps and reports whether the
// window is empty.
func (w *searchWindow) stored() (after, before string, empty bool) {
	if !w.lo.IsZero() {
		after = w.lo.UTC().Format(searchTSLayout)
	}
	if !w.hi.IsZero() {
		before = w.hi.UTC().Format(searchTSLayout)
	}
	return after, before, !w.lo.IsZero() && !w.hi.IsZero() && !w.lo.Before(w.hi)
}

// searchDayRange turns one date filter into its half-open [lo, hi) bounds in
// local time; a zero bound is unbounded. before:D is (-inf, D), after:D is
// [D+1, inf) and during:D is [D, D+1), each at local midnight.
func searchDayRange(key, val string, loc *time.Location) (lo, hi time.Time, err error) {
	day, err := parseSearchDay(key, val, loc)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	next := day.AddDate(0, 0, 1)
	switch key {
	case "before":
		return time.Time{}, day, nil
	case "after":
		return next, time.Time{}, nil
	default: // during
		return day, next, nil
	}
}

// loadSearchLocation resolves the tz parameter; empty is UTC.
func loadSearchLocation(tz string) (*time.Location, error) {
	if tz == "" || tz == "UTC" {
		return time.UTC, nil
	}
	if len(tz) > maxSearchTZLen || strings.EqualFold(tz, "Local") {
		return nil, fmt.Errorf("%w: tz must be an IANA time zone name", ErrBadRequest)
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, fmt.Errorf("%w: tz must be an IANA time zone name", ErrBadRequest)
	}
	return loc, nil
}

// parseSearchDay parses a YYYY-MM-DD value as local midnight in loc. Years
// outside 1..9998 are refused so the stored-format string comparison stays
// well defined.
func parseSearchDay(key, val string, loc *time.Location) (time.Time, error) {
	d, err := time.Parse(searchDateLayout, val)
	if err != nil || d.Year() < 1 || d.Year() > 9998 {
		return time.Time{}, fmt.Errorf("%w: %s: expects a date as YYYY-MM-DD", ErrBadRequest, key)
	}
	return time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, loc), nil
}
