package ws

// Client features: optional capabilities a client declares in its
// auth frame (`features: string[]`, additive within epoch 1, absent = none).
// The server keeps the parsed set on the Client for the socket's life; every
// connection sends a fresh auth, so a client that updates re-declares. The set
// is UNTRUSTED input and only ever narrows what a socket is sent: it grants
// nothing.
const (
	// featureForums marks a client that can render a forum channel. A socket
	// without it is sent no forum row in ready and no forum channel_create,
	// because an older client would type a forum as an empty text channel
	// with a composer whose sends are refused.
	featureForums = "forums"

	// featureMobile marks the Android app. The web client in a phone browser does
	// not declare it and counts as a desktop. It decides only whether other
	// members see the phone icon on the user's status (mergeLivePresence).
	featureMobile = "mobile"

	// maxAuthFeatures and maxAuthFeatureLen bound what the parser reads from
	// the auth frame, so a hostile list costs nothing.
	maxAuthFeatures   = 32
	maxAuthFeatureLen = 32
)

// clientFeatures is the parsed feature set of one socket. The zero value is a
// client that declared nothing.
type clientFeatures struct {
	forums bool
	mobile bool
}

// parseClientFeatures reads the auth frame's features list. Unknown names are
// ignored, which is what lets a newer client declare more than this server
// knows.
func parseClientFeatures(raw []string) clientFeatures {
	var f clientFeatures
	for i, name := range raw {
		if i >= maxAuthFeatures {
			break
		}
		if len(name) > maxAuthFeatureLen {
			continue
		}
		switch name {
		case featureForums:
			f.forums = true
		case featureMobile:
			f.mobile = true
		}
	}
	return f
}

// channelTypeForum is the channels.type value of a forum (migration 075).
const channelTypeForum = "forum"

// allowsType reports whether a socket with these features is sent a channel of
// chType in ready or a targeted channel_create. Only a forum is gated.
func (f clientFeatures) allowsType(chType string) bool {
	return chType != channelTypeForum || f.forums
}

// sendsChannel is allowsType for a live client; nil sends nothing.
func (c *Client) sendsChannel(chType string) bool {
	return c != nil && c.features.allowsType(chType)
}
