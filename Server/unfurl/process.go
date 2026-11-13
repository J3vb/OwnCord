package unfurl

import (
	"context"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/externalcontent"
	"github.com/J3vb/OwnCord/Server/imgthumb"
	"github.com/J3vb/OwnCord/Server/linkpreview"
	"github.com/J3vb/OwnCord/Server/linkwire"
)

const (
	// cardFreshFor is how long a fetched card is reused before the page is fetched again.
	cardFreshFor = 7 * 24 * time.Hour
	// failureFreshFor is how long a failed fetch is remembered, so a dead link costs one fetch an hour.
	failureFreshFor = time.Hour
	// thumbBox is the largest side of a stored thumbnail, in pixels.
	thumbBox = 640
	// youtubeSite is the site name of a YouTube card, as the client shows it.
	youtubeSite = "YouTube"
)

// process unfurls one message: it makes sure every link has a stored card, then replaces the
// message's links in one guarded write, and announces the result when the message shows cards
// or did before. A result for a message that was edited or deleted meanwhile is dropped.
func (u *Unfurler) process(ctx context.Context, job linkpreview.Job) {
	links := linkpreview.Links(job.Content)
	var hadCards bool
	if job.Edited {
		prev, err := u.store.MessagePreviews(ctx, job.MessageID)
		if err != nil {
			u.log.Warn("link preview: reading earlier cards failed", "message_id", job.MessageID, "error", err)
			return
		}
		hadCards = len(linkwire.Cards(prev)) > 0
	}
	if len(links) == 0 && !hadCards {
		return
	}
	hashes := make([]string, 0, len(links))
	for _, l := range links {
		if ctx.Err() != nil {
			return
		}
		if !u.ensure(ctx, l) {
			// Not recorded as unfurled, so a later history read tries the message again.
			return
		}
		hashes = append(hashes, l.Hash)
	}
	applied, err := u.store.ReplaceMessagePreviews(ctx, job.MessageID, job.Version, job.Content, hashes)
	if err != nil {
		u.log.Warn("link preview: storing message previews failed", "message_id", job.MessageID, "error", err)
		return
	}
	if !applied {
		return
	}
	rows, err := u.store.MessagePreviews(ctx, job.MessageID)
	if err != nil {
		u.log.Warn("link preview: reading message previews failed", "message_id", job.MessageID, "error", err)
		return
	}
	cards := linkwire.Cards(rows)
	if len(cards) == 0 && !hadCards {
		return
	}
	// The write committed: announce on a context that outlives a shutdown that has begun.
	u.ann.LinkPreviewsReady(context.WithoutCancel(ctx), Ready{
		MessageID: job.MessageID, ChannelID: job.ChannelID, AuthorID: job.AuthorID, Cards: cards,
	})
}

// ensure makes sure a current card, or a recent failure, is stored for the link, fetching it
// once however many messages ask at the same time. It reports false when it could not.
func (u *Unfurler) ensure(ctx context.Context, l linkpreview.Link) bool {
	if u.current(ctx, l.Hash) {
		return true
	}
	_, err, _ := u.flight.Do(l.Hash, func() (any, error) {
		// A flight that started just after another finished finds the card it stored.
		if u.current(ctx, l.Hash) {
			return nil, nil
		}
		return nil, u.fetchAndStore(ctx, l)
	})
	if err != nil {
		u.log.Warn("link preview: storing a card failed", "error", err)
		return false
	}
	return true
}

// current reports whether a stored card for hash is recent enough to reuse.
func (u *Unfurler) current(ctx context.Context, hash string) bool {
	p, err := u.store.Preview(ctx, hash)
	if err != nil {
		return false
	}
	fetched, err := time.Parse(time.RFC3339, p.FetchedAt)
	if err != nil {
		return false
	}
	limit := cardFreshFor
	if p.Failure != nil {
		limit = failureFreshFor
	}
	return u.now().Sub(fetched) < limit
}

// fetchAndStore fetches a link and stores the outcome: a card, or the failure that ended the
// fetch. A fetch cut short by shutdown, or one that found no free fetch slot, says nothing
// about the link, so nothing is stored and the caller reports it.
func (u *Unfurler) fetchAndStore(ctx context.Context, l linkpreview.Link) error {
	stamp := linkpreview.FormatTime(u.now())
	p := linkpreview.Preview{UrlHash: l.Hash, Url: l.URL, FetchedAt: stamp, LastUsedAt: stamp}
	var img *linkpreview.NewImage
	var fetchErr error
	if id := youtubeID(l.URL); id != "" {
		img, fetchErr = u.fetchYouTube(ctx, &p, id)
	} else {
		img, fetchErr = u.fetchPage(ctx, &p, l.URL)
	}
	if fetchErr != nil {
		if ctx.Err() != nil || externalcontent.IsTransient(fetchErr) {
			return fmt.Errorf("fetching %s: %w", l.URL, fetchErr)
		}
		failure := string(externalcontent.FailureOf(fetchErr))
		p.Failure = &failure
	}
	if err := u.store.PutCard(ctx, p, img, u.opt.ThumbCapBytes); err != nil {
		return fmt.Errorf("storing card: %w", err)
	}
	return nil
}

// fetchPage fills p from the page at rawURL. A link that is itself a picture becomes a card
// with only its image. The error is the page's, when it gave no card.
func (u *Unfurler) fetchPage(ctx context.Context, p *linkpreview.Preview, rawURL string) (*linkpreview.NewImage, error) {
	page, err := u.src.Page(ctx, rawURL)
	if err != nil {
		if externalcontent.FailureOf(err) == externalcontent.WrongType {
			if data, mime, imgErr := u.src.Image(ctx, rawURL); imgErr == nil {
				if img := thumbnail(data, mime); img != nil {
					return img, nil
				}
			}
		}
		return nil, fmt.Errorf("page %s: %w", rawURL, err)
	}
	p.Title, p.Description, p.SiteName = page.Title, page.Description, page.SiteName
	return u.fetchPicture(ctx, page.ImageURL), nil
}

// fetchYouTube fills p the way the client builds a YouTube card: the oEmbed title, the site
// name and the video's still.
func (u *Unfurler) fetchYouTube(ctx context.Context, p *linkpreview.Preview, id string) (*linkpreview.NewImage, error) {
	oembed := "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=" + id + "&format=json"
	page, err := u.src.Page(ctx, oembed)
	if err != nil {
		return nil, fmt.Errorf("youtube title: %w", err)
	}
	site := youtubeSite
	p.Title, p.SiteName = page.Title, &site
	return u.fetchPicture(ctx, "https://img.youtube.com/vi/"+id+"/mqdefault.jpg"), nil
}

// fetchPicture fetches and shrinks a card's picture. A picture that cannot be had leaves the
// card without one; the card keeps its text.
func (u *Unfurler) fetchPicture(ctx context.Context, imageURL string) *linkpreview.NewImage {
	if imageURL == "" || u.opt.ThumbCapBytes <= 0 {
		return nil
	}
	data, mime, err := u.src.Image(ctx, imageURL)
	if err != nil {
		return nil
	}
	return thumbnail(data, mime)
}

// thumbnail shrinks a fetched picture to the stored size, or returns nil when it cannot be
// decoded. The declared type is not used: the bytes say what the picture is.
func thumbnail(data []byte, _ string) *linkpreview.NewImage {
	s, ok := imgthumb.Fit(data, thumbBox)
	if !ok {
		return nil
	}
	return &linkpreview.NewImage{Data: s.Data, MIME: s.MIME, Width: s.Width, Height: s.Height}
}
