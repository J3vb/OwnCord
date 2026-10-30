package service

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

// SearchRequest is one search call: the raw query (free text plus filter
// tokens), an optional single-channel scope, the caller's time zone for date
// filters, and the page to fetch.
type SearchRequest struct {
	Query     string
	ChannelID *int64
	// TZ is an IANA zone name for before:/after:/during:; empty means UTC.
	TZ   string
	Page db.SearchPage
}

// SearchMessages performs full-text search across the channels the caller may
// read and returns one page of hits. nextBefore is the cursor for the
// following page of a Recent search (0 when there is none). A query with
// filters but no words is newest-first only.
func (s *MessageService) SearchMessages(ctx context.Context, userID int64, in SearchRequest) (results []db.MessageSearchResult, nextBefore int64, err error) {
	if in.Query == "" {
		return nil, 0, fmt.Errorf("%w: query cannot be empty", ErrBadRequest)
	}
	parsed, err := ParseSearch(in.Query, in.TZ)
	if err != nil {
		return nil, 0, err
	}
	hasWords := db.HasSearchTerms(parsed.Text)
	if !hasWords && !parsed.HasFilters {
		return nil, 0, nil
	}

	page := in.Page
	if page.Limit <= 0 {
		page.Limit = 50
	}
	if page.Limit > 100 {
		page.Limit = 100
	}
	limit := page.Limit
	if !hasWords {
		// No FTS driver means no relevance order: newest first, id-cursor paged.
		page.Recent = true
	}
	if page.Recent {
		// Fetch one extra to learn whether another page follows.
		page.Limit++
	}

	scope, err := s.searchScope(ctx, userID, in.ChannelID, parsed.In)
	if err != nil {
		return nil, 0, err
	}
	if len(scope) == 0 || parsed.EmptyRange {
		return nil, 0, nil
	}

	var authorIDs []int64
	if len(parsed.From) > 0 {
		authorIDs, err = s.resolveSearchUsers(ctx, parsed.From)
		if err != nil {
			return nil, 0, err
		}
		if len(authorIDs) == 0 {
			return nil, 0, nil
		}
	}

	var mentionIDs []int64
	if len(parsed.Mentions) > 0 {
		mentionIDs, err = s.resolveSearchMentions(ctx, parsed.Mentions)
		if err != nil {
			return nil, 0, err
		}
		if len(mentionIDs) == 0 {
			// mentions: values are AND'd, so one unknown name matches nothing.
			return nil, 0, nil
		}
	}

	results, err = s.st.SearchMessagesFiltered(ctx, db.SearchQuery{
		Text:       parsed.Text,
		ChannelIDs: scope,
		AuthorIDs:  authorIDs,
		AfterTS:    parsed.AfterTS,
		BeforeTS:   parsed.BeforeTS,
		MentionIDs: mentionIDs,
		Has:        parsed.Has,
		Pinned:     parsed.Pinned,
	}, page)
	if err != nil {
		return nil, 0, fmt.Errorf("%w: search failed: %w", ErrInternal, err)
	}
	if len(results) > limit {
		results = results[:limit]
		nextBefore = results[limit-1].MessageID
	}
	return results, nextBefore, nil
}

// searchScope returns the channel ids a search may touch. An explicit channelID
// keeps the single-channel 403/404 contract; otherwise the scope is the caller's
// READABLE set (visible minus labelled channels the caller has not acknowledged, so
// a hit inside one is silently absent; a gate on the single-channel branch alone
// leaves that leak open). in: names narrow the scope and are compared only against
// channels already in it, so an unreadable or nonexistent target looks like any
// name that matches nothing.
func (s *MessageService) searchScope(ctx context.Context, userID int64, channelID *int64, inNames []string) ([]int64, error) {
	var scope []int64
	if channelID != nil && *channelID > 0 {
		if err := s.requireSearchChannelAccess(ctx, userID, *channelID); err != nil {
			return nil, err
		}
		scope = []int64{*channelID}
	} else {
		ids, err := s.ReadableChannelIDs(ctx, userID)
		if err != nil {
			return nil, err
		}
		scope = ids
	}
	if len(scope) == 0 || len(inNames) == 0 {
		return scope, nil
	}

	channels, err := s.st.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list channels: %w", ErrInternal, err)
	}
	inScope := make(map[int64]bool, len(scope))
	for _, id := range scope {
		inScope[id] = true
	}
	narrowed := make([]int64, 0, len(inNames))
	for i := range channels {
		ch := &channels[i]
		if !inScope[ch.ID] {
			continue
		}
		for _, name := range inNames {
			if strings.EqualFold(strings.TrimSpace(ch.Name), name) {
				narrowed = append(narrowed, ch.ID)
				break
			}
		}
	}
	return narrowed, nil
}

// resolveSearchUsers maps usernames to ids; unknown names are dropped.
func (s *MessageService) resolveSearchUsers(ctx context.Context, names []string) ([]int64, error) {
	ids := make([]int64, 0, len(names))
	seen := make(map[int64]bool, len(names))
	for _, name := range names {
		u, err := s.st.GetUserByUsername(ctx, name)
		if err != nil {
			return nil, fmt.Errorf("%w: user lookup failed: %w", ErrInternal, err)
		}
		if u == nil || seen[u.ID] {
			continue
		}
		seen[u.ID] = true
		ids = append(ids, u.ID)
	}
	return ids, nil
}

// resolveSearchMentions maps mentions: usernames to distinct user ids. The
// result is empty when any name is unknown: mentions: values are AND'd, so one
// unknown user means nothing can match. Two spellings of one user collapse to
// one id.
func (s *MessageService) resolveSearchMentions(ctx context.Context, names []string) ([]int64, error) {
	ids := make([]int64, 0, len(names))
	for _, name := range names {
		u, err := s.st.GetUserByUsername(ctx, name)
		if err != nil {
			return nil, fmt.Errorf("%w: user lookup failed: %w", ErrInternal, err)
		}
		if u == nil {
			return nil, nil
		}
		if !slices.Contains(ids, u.ID) {
			ids = append(ids, u.ID)
		}
	}
	return ids, nil
}
