package unfurl

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/externalcontent"
)

// Page is what fetching a link yields: the card text and the address of its picture.
type Page struct {
	Title       *string
	Description *string
	SiteName    *string
	// ImageURL is the page's picture, or "" for none.
	ImageURL string
}

// Source fetches the pages and pictures of links. An error from it is a failed fetch: when it
// is an externalcontent error its failure class is stored, anything else is "unavailable".
type Source interface {
	// Page fetches a link and reduces it to its Open Graph or oEmbed fields.
	Page(ctx context.Context, rawURL string) (Page, error)
	// Image fetches a picture and returns its bytes and verified media type.
	Image(ctx context.Context, rawURL string) ([]byte, string, error)
}

// BrokerSource fetches through the externalcontent broker, and so under the safefetch page and
// image policies: public addresses only, bounded size, time and redirects.
type BrokerSource struct {
	Broker *externalcontent.Broker
}

// Page implements Source.
func (s BrokerSource) Page(ctx context.Context, rawURL string) (Page, error) {
	c, err := s.Broker.Card(ctx, rawURL)
	if err != nil {
		return Page{}, fmt.Errorf("fetching page: %w", err)
	}
	return Page{Title: c.Title, Description: c.Description, SiteName: c.SiteName, ImageURL: c.ImageURL}, nil
}

// Image implements Source.
func (s BrokerSource) Image(ctx context.Context, rawURL string) ([]byte, string, error) {
	data, mime, err := s.Broker.ImageAt(ctx, rawURL)
	if err != nil {
		return nil, "", fmt.Errorf("fetching image: %w", err)
	}
	return data, mime, nil
}
