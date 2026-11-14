// Package linkwire is the shape of a link preview card on the wire: the link_previews array
// of a message and of a message_link_previews event. It depends only on the generated row
// type, so the database layer can embed it in a message and the store can build it without
// either importing the other.
package linkwire

import "github.com/J3vb/OwnCord/Server/db/dbgen"

// Image names a card's stored thumbnail, fetched from /api/v1/link-previews/images/{hash}.
type Image struct {
	Hash   string `json:"hash"`
	Width  int64  `json:"width"`
	Height int64  `json:"height"`
}

// Card is one link preview as clients receive it.
type Card struct {
	URL         string  `json:"url"`
	Title       *string `json:"title,omitempty"`
	Description *string `json:"description,omitempty"`
	SiteName    *string `json:"site_name,omitempty"`
	Image       *Image  `json:"image,omitempty"`
}

// FromRow builds the wire card of one stored row. It reports false for a row that shows
// nothing: a failed fetch, or a page with no title, description, site name or thumbnail.
func FromRow(r dbgen.ListMessageLinkPreviewsRow) (Card, bool) {
	if r.Failure != nil {
		return Card{}, false
	}
	c := Card{URL: r.Url, Title: text(r.Title), Description: text(r.Description), SiteName: text(r.SiteName)}
	if r.ImageHash != nil && r.ImageWidth != nil && r.ImageHeight != nil {
		c.Image = &Image{Hash: *r.ImageHash, Width: *r.ImageWidth, Height: *r.ImageHeight}
	}
	if c.Title == nil && c.Description == nil && c.SiteName == nil && c.Image == nil {
		return Card{}, false
	}
	return c, true
}

func text(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

// Cards returns the wire cards of rows that show something, in row order.
func Cards(rows []dbgen.ListMessageLinkPreviewsRow) []Card {
	out := make([]Card, 0, len(rows))
	for i := range rows {
		if c, ok := FromRow(rows[i]); ok {
			out = append(out, c)
		}
	}
	return out
}
