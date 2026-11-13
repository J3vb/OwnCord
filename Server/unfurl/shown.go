package unfurl

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

const (
	// shownFlushEvery is how often the cards and thumbnails readers were given are marked used.
	shownFlushEvery = 30 * time.Second
	// shownMax bounds each pending set; hashes past it are not recorded, which only makes a
	// card look a little older than it is.
	shownMax = 8192
	// shownFlushTimeout bounds one flush, including the final one at shutdown.
	shownFlushTimeout = 5 * time.Second
)

// shownSet collects the hashes of cards and thumbnails recently shown, so history reads
// cost no write: a flush marks them used in two statements.
type shownSet struct {
	// mu guards the maps. A leaf lock.
	mu     syncutil.Mutex
	cards  map[string]struct{}
	images map[string]struct{}
}

func (s *shownSet) note(urlHashes, imageHashes []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cards == nil {
		s.cards, s.images = make(map[string]struct{}), make(map[string]struct{})
	}
	for _, h := range urlHashes {
		if len(s.cards) < shownMax {
			s.cards[h] = struct{}{}
		}
	}
	for _, h := range imageHashes {
		if len(s.images) < shownMax {
			s.images[h] = struct{}{}
		}
	}
}

func (s *shownSet) take() (urlHashes, imageHashes []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for h := range s.cards {
		urlHashes = append(urlHashes, h)
	}
	for h := range s.images {
		imageHashes = append(imageHashes, h)
	}
	s.cards, s.images = nil, nil
	return urlHashes, imageHashes
}

// NoteShown implements linkpreview.Unfurler.
func (u *Unfurler) NoteShown(urlHashes, imageHashes []string) {
	u.shown.note(urlHashes, imageHashes)
}

// flushShown marks what readers were shown as used. It runs on ctx's values with its own
// deadline, since the last flush happens after ctx ended.
func (u *Unfurler) flushShown(ctx context.Context) {
	cards, images := u.shown.take()
	if len(cards)+len(images) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shownFlushTimeout)
	defer cancel()
	if err := u.store.TouchMany(ctx, cards, images); err != nil {
		u.log.Warn("link preview last-used update failed", "error", err)
	}
}

// runShown flushes on a ticker until ctx ends, then once more.
func (u *Unfurler) runShown(ctx context.Context) {
	t := time.NewTicker(shownFlushEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			u.flushShown(ctx)
			return
		case <-t.C:
			u.flushShown(ctx)
		}
	}
}
