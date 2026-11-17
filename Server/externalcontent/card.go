package externalcontent

import "context"

// Card is what a page reduces to for a stored link preview: the Open Graph or oEmbed text and
// the address of its image, not yet a handle. It is public content fetched without credentials,
// the same for every viewer, so it carries no owner.
type Card struct {
	Title       *string
	Description *string
	SiteName    *string
	// ImageURL is the page's image resolved against the page's final address, or "" for none.
	ImageURL    string
	ImageWidth  *uint32
	ImageHeight *uint32
}

// Card fetches rawURL under the page policy and reduces it as Preview does, without minting an
// image handle. Results and failures share Preview's cache and flight, so a page asked for
// twice at once is one fetch.
func (b *Broker) Card(ctx context.Context, rawURL string) (Card, error) {
	if len(rawURL) > maxURLBytes {
		return Card{}, fail(BlockedDestination)
	}
	data, err := b.cachedPreview(ctx, "preview:"+rawURL, rawURL)
	if err != nil {
		return Card{}, err
	}
	return Card(data), nil
}

// ImageAt fetches the image at rawURL under the image policy and returns its bytes and media
// type, which the bytes were checked to match. It shares Image's cache and flight.
func (b *Broker) ImageAt(ctx context.Context, rawURL string) ([]byte, string, error) {
	return b.Image(ctx, 0, "", rawURL)
}
