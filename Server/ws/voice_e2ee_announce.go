package ws

// e2eeAnnounce is what a client announced with voice_e2ee_announce: the ECDH P-256 public
// key (base64), the identity-key signature over it ("" for legacy announces) and the
// sanitized video decode list (nil when absent). Stored, replayed and carried across resume
// and the grace window as one value so no path can drop a field. Guarded by voiceSlot.voiceMu.
type e2eeAnnounce struct {
	key         string
	sig         string
	videoDecode []string
	// identityKey is the identity public key of the device that made this announce: the
	// payload's own identity_public_key if valid, else its connection's auth-frame key, else "".
	// Stored with the announce so every replay carries the announcing device's key.
	identityKey string
	// keySlots is true when the client installs each new room key in its own key slot and
	// switches a moment later (key_slots); the key holder rotates that way only when every peer says so.
	keySlots bool
	// boundOffers is true when the client unwraps room-key offers binding sender and recipient
	// (bound_offers); the key holder sends such a peer that format.
	boundOffers bool
}

func (a e2eeAnnounce) clone() e2eeAnnounce {
	if a.videoDecode != nil {
		a.videoDecode = append([]string(nil), a.videoDecode...)
	}
	return a
}

// setE2EEAnnounce stores the announce, replacing any earlier one (an announce without a video decode list
// clears it).
func (c *Client) setE2EEAnnounce(a e2eeAnnounce) {
	c.voice.setE2EE(a.clone())
}

func (c *Client) getE2EEAnnounce() e2eeAnnounce {
	return c.voice.e2eeCopy()
}
