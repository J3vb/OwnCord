package service

import (
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"

	// Embed the IANA zone database so a tz name resolves on hosts that ship
	// none (a Windows server without a Go install).
	_ "time/tzdata"

	"github.com/J3vb/OwnCord/Server/dbtime"
)

// Limits on filter tokens in one search query (design D12).
const (
	maxSearchFilterTokens = 25
	maxSearchFilterValues = 10
	maxSearchTZLen        = 64

	searchDateLayout = "2006-01-02"
)

// ParsedSearch is a search query split into free text and typed filters.
type ParsedSearch struct {
	// Text is the free text: the non-filter tokens joined by one space, or the
	// query byte for byte when it holds no filter token at all.
	Text string
	// From and In are the raw usernames and channel names, in order of
	// appearance, with any leading @ or # removed.
	From, In []string
	// Mentions are the raw usernames of mentions: values, in order, with any
	// leading @ removed.
	Mentions []string
	// Has holds the distinct has: kinds (link, file, image, video, sound),
	// normalised to lower case with the audio alias folded into sound.
	Has []string
	// Pinned is set by pinned:true or pinned:false.
	Pinned *bool
	// AfterTS and BeforeTS are the date bounds as stored UTC timestamps:
	// timestamp >= AfterTS and timestamp < BeforeTS. Empty means unbounded.
	AfterTS, BeforeTS string
	// EmptyRange is set when the filters can match nothing: the date filters
	// intersect to nothing, or pinned:true and pinned:false are both given.
	EmptyRange bool
	// HasFilters reports whether any non-empty filter value was given.
	HasFilters bool
}

// searchKey names a filter key active in this version.
func searchKey(k string) (string, bool) {
	switch k {
	case "from", "in", "before", "after", "during", "has", "mentions", "pinned":
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
	case "from", "mentions":
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
		st       = searchState{loc: loc}
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
		if err := st.add(&p, tok); err != nil {
			return ParsedSearch{}, err
		}
	}

	if consumed {
		p.Text = strings.Join(words, " ")
	} else {
		p.Text = q
	}
	p.AfterTS, p.BeforeTS, p.EmptyRange = st.window.stored()
	if st.contradiction {
		p.EmptyRange = true
	}
	return p, nil
}

// searchState carries what ParseSearch accumulates across filter tokens
// beyond the fields of ParsedSearch itself.
type searchState struct {
	loc           *time.Location
	window        searchWindow
	hasValues     int
	contradiction bool
}

// add records one non-empty filter token into p and enforces the per-kind
// value cap.
func (st *searchState) add(p *ParsedSearch, tok searchToken) error {
	switch tok.key {
	case "from":
		p.From = append(p.From, tok.val)
	case "in":
		p.In = append(p.In, tok.val)
	case "mentions":
		p.Mentions = append(p.Mentions, tok.val)
	case "has":
		st.hasValues++
		kind, err := searchHasKind(tok.val)
		if err != nil {
			return err
		}
		if !slices.Contains(p.Has, kind) {
			p.Has = append(p.Has, kind)
		}
	case "pinned":
		want, err := searchPinned(tok.val)
		if err != nil {
			return err
		}
		if p.Pinned != nil && *p.Pinned != want {
			st.contradiction = true
		}
		p.Pinned = &want
	default:
		lo, hi, err := searchDayRange(tok.key, tok.val, st.loc)
		if err != nil {
			return err
		}
		st.window.intersect(lo, hi)
	}
	if len(p.From) > maxSearchFilterValues || len(p.In) > maxSearchFilterValues ||
		len(p.Mentions) > maxSearchFilterValues || st.hasValues > maxSearchFilterValues {
		return fmt.Errorf("%w: %s: allows at most %d values", ErrBadRequest, tok.key+":", maxSearchFilterValues)
	}
	return nil
}

// searchHasKind validates a has: value and folds it to its canonical kind.
// embed, sticker and poll are not supported and are refused like any other
// unknown value, so a user typing them learns the filter did not apply.
func searchHasKind(val string) (string, error) {
	switch v := strings.ToLower(val); v {
	case "link", "file", "image", "video", "sound":
		return v, nil
	case "audio":
		return "sound", nil
	}
	return "", fmt.Errorf("%w: has: expects link, file, image, video or sound", ErrBadRequest)
}

// searchPinned validates a pinned: value.
func searchPinned(val string) (bool, error) {
	switch strings.ToLower(val) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	}
	return false, fmt.Errorf("%w: pinned: expects true or false", ErrBadRequest)
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
		after = w.lo.UTC().Format(dbtime.SQLiteLayout)
	}
	if !w.hi.IsZero() {
		before = w.hi.UTC().Format(dbtime.SQLiteLayout)
	}
	return after, before, !w.lo.IsZero() && !w.hi.IsZero() && !w.lo.Before(w.hi)
}

// searchDayRange turns one date filter into its half-open [lo, hi) bounds in
// local time; a zero bound is unbounded. before:D is (-inf, D), after:D is
// [D+1, inf) and during:D is [D, D+1), each at local midnight.
func searchDayRange(key, val string, loc *time.Location) (lo, hi time.Time, err error) {
	day, next, err := parseSearchDay(key, val, loc)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
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

// parseSearchDay parses a YYYY-MM-DD value as local midnight in loc and
// returns that day's start and the next day's start. Both are built from the
// calendar date, so a zone whose DST change skips midnight still gets the
// right next-day bound. Years outside 1..9998 are refused so the
// stored-format string comparison stays well defined.
func parseSearchDay(key, val string, loc *time.Location) (day, next time.Time, err error) {
	d, err := time.Parse(searchDateLayout, val)
	if err != nil || d.Year() < 1 || d.Year() > 9998 {
		return time.Time{}, time.Time{}, fmt.Errorf("%w: %s: expects a date as YYYY-MM-DD", ErrBadRequest, key)
	}
	day = time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, loc)
	next = time.Date(d.Year(), d.Month(), d.Day()+1, 0, 0, 0, 0, loc)
	return day, next, nil
}
