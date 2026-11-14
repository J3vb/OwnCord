package db

import "github.com/J3vb/OwnCord/Server/linkwire"

// LinkPreviews is the wire field for a message's link cards; embedded in MessageAPIResponse,
// absent until the server has unfurled the message and the cards show something.
type LinkPreviews struct {
	Cards []linkwire.Card `json:"link_previews,omitempty"`
}
