package ws

// Client features: optional capabilities a client declares in its auth frame
// (additive, absent = none). The set is UNTRUSTED input and only ever narrows
// what a socket is sent; it grants nothing.
const (
	// featureForums marks a client that can render a forum channel. Without it a
	// socket is sent no forum row in ready and no forum channel_create, since an
	// older client would show a forum as a text channel whose sends are refused.
	featureForums = "forums"

	// featureMobile marks the Android app (a phone browser counts as desktop); it
	// only decides the phone icon on the user's status (mergeLivePresence).
	featureMobile = "mobile"

	// maxAuthFeatures and maxAuthFeatureLen bound what the parser reads, so a
	// hostile list costs nothing.
	maxAuthFeatures   = 32
	maxAuthFeatureLen = 32
)

type clientFeatures struct {
	forums bool
	mobile bool
}

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

const channelTypeForum = "forum"

// allowsType reports whether a socket is sent a channel of chType in ready or a
// targeted channel_create; only a forum is gated.
func (f clientFeatures) allowsType(chType string) bool {
	return chType != channelTypeForum || f.forums
}

func (c *Client) sendsChannel(chType string) bool {
	return c != nil && c.features.allowsType(chType)
}
