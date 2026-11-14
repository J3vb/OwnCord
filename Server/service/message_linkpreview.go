package service

import (
	"context"
	"fmt"
	"log/slog"
	"slices"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/linkpreview"
	"github.com/J3vb/OwnCord/Server/linkwire"
)

// backfillPerPage caps how many never-unfurled messages one page of history queues.
const backfillPerPage = 20

// linkPreviewReader is what history reads from the link preview store; *linkpreview.Store
// satisfies it.
type linkPreviewReader interface {
	PreviewsForMessages(ctx context.Context, messageIDs []int64) ([]linkpreview.Card, error)
}

// SetLinkPreviews gives history the store it attaches cards from; nil attaches none. The root
// calls it once at start.
func (s *MessageService) SetLinkPreviews(r linkPreviewReader) { s.previews = r }

// SetLinkUnfurler gives the service the queue committed messages are handed to, and history the
// queue it backfills old messages through; nil leaves link previews to what is already stored.
func (s *MessageService) SetLinkUnfurler(u linkpreview.Unfurler) { s.unfurler = u }

// enqueueUnfurl hands a committed message to the unfurl queue. It never waits and never fails
// the send: the queue drops the job when full.
func (s *MessageService) enqueueUnfurl(job linkpreview.Job) {
	if s.unfurler == nil {
		return
	}
	s.unfurler.Enqueue(job)
}

// LinkPreviewAudience is who hears a link preview update for a message in channelID: whether
// it is a DM and, if so, the participants the first-contact gate lets see the message. A DM
// whose audience cannot be read is an error, so nothing is sent to the channel topic instead.
func (s *MessageService) LinkPreviewAudience(ctx context.Context, channelID, authorID int64) (isDM bool, participants []int64, err error) {
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil {
		return false, nil, fmt.Errorf("reading channel %d: %w", channelID, err)
	}
	if ch == nil {
		return false, nil, fmt.Errorf("channel %d: %w", channelID, ErrNotFound)
	}
	if ch.Type != "dm" {
		return false, nil, nil
	}
	ids, err := s.DMAudience(ctx, channelID, authorID)
	if err != nil {
		return true, nil, fmt.Errorf("reading dm audience of %d: %w", channelID, err)
	}
	if len(ids) == 0 {
		return true, nil, fmt.Errorf("dm %d has no audience: %w", channelID, ErrNotFound)
	}
	return true, ids, nil
}

// attachLinkPreviews sets the link cards of a page of history, from one batch read. Only a
// card whose link the message's text still has is attached, so an edit that removed a link
// hides its card at once. A message that has links but not all their cards is queued for
// unfurling at low priority, newest first, up to backfillPerPage a page. Whatever was shown
// is noted for a batched last-used update. A failure here only leaves cards off the page.
func (s *messageReads) attachLinkPreviews(ctx context.Context, msgs []db.MessageAPIResponse) {
	if s.previews == nil {
		return
	}
	wanted := make(map[int64]map[string]struct{}, len(msgs))
	ids := make([]int64, 0, len(msgs))
	for i := range msgs {
		m := &msgs[i]
		if m.Deleted || m.Kind != "" {
			continue
		}
		links := linkpreview.Links(m.Content)
		if len(links) == 0 {
			continue
		}
		set := make(map[string]struct{}, len(links))
		for _, l := range links {
			set[l.Hash] = struct{}{}
		}
		wanted[m.ID] = set
		ids = append(ids, m.ID)
	}
	if len(ids) == 0 {
		return
	}
	rows, err := s.previews.PreviewsForMessages(ctx, ids)
	if err != nil {
		slog.Warn("history link previews unavailable", "error", err)
		return
	}
	byMessage := make(map[int64][]linkpreview.Card, len(ids))
	for i := range rows {
		r := &rows[i]
		if _, ok := wanted[r.MessageID][r.UrlHash]; ok {
			byMessage[r.MessageID] = append(byMessage[r.MessageID], *r)
		}
	}
	var shownCards, shownImages []string
	var backfill []linkpreview.Job
	for i := range msgs {
		m := &msgs[i]
		set, ok := wanted[m.ID]
		if !ok {
			continue
		}
		own := byMessage[m.ID]
		m.Cards = linkwire.Cards(own)
		for j := range own {
			r := &own[j]
			shownCards = append(shownCards, r.UrlHash)
			if r.ImageHash != nil {
				shownImages = append(shownImages, *r.ImageHash)
			}
		}
		if len(own) < len(set) {
			backfill = append(backfill, backfillJob(m))
		}
	}
	if s.unfurler == nil {
		return
	}
	s.unfurler.NoteShown(shownCards, shownImages)
	if len(backfill) > 0 {
		slices.SortFunc(backfill, func(a, b linkpreview.Job) int { return int(b.MessageID - a.MessageID) })
		s.unfurler.EnqueueBackfill(backfill[:min(len(backfill), backfillPerPage)])
	}
}

func backfillJob(m *db.MessageAPIResponse) linkpreview.Job {
	version := m.Timestamp
	if m.EditedAt != nil {
		version = *m.EditedAt
	}
	return linkpreview.Job{
		MessageID: m.ID, ChannelID: m.ChannelID, AuthorID: m.User.ID,
		Content: m.Content, Version: version,
	}
}
