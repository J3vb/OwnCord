package ws

// e2eeAnnounce is what a client announced with voice_e2ee_announce: the ECDH
// P-256 public key (base64), the identity-key signature over it (F3 TOFU; ""
// for legacy announces) and the sanitized video decode list (WP M-4; nil when
// absent). It is stored, replayed and carried across resume and the grace
// window as one value so no path can drop a field. Guarded by voiceSlot.voiceMu.
type e2eeAnnounce struct {
	key         string
	sig         string
	videoDecode []string
	// identityKey is the identity public key of the device that made this
	// announce: the announce payload's own identity_public_key when it sent a
	// valid one, else its connection's auth-frame key; "" when it sent neither.
	// It is stored with the announce, so every replay carries the key of the
	// device that announced, not whichever device the user signed in on last.
	identityKey string
}

// clone returns a copy that shares no slice storage with the receiver.
func (a e2eeAnnounce) clone() e2eeAnnounce {
	if a.videoDecode != nil {
		a.videoDecode = append([]string(nil), a.videoDecode...)
	}
	return a
}

// setE2EEAnnounce stores the announce for voice E2EE key exchange, replacing
// any earlier one (an announce without a video decode list clears it).
func (c *Client) setE2EEAnnounce(a e2eeAnnounce) {
	c.voice.setE2EE(a.clone())
}

// getE2EEAnnounce returns a copy of the stored announce; callers cannot
// mutate the stored video decode list.
func (c *Client) getE2EEAnnounce() e2eeAnnounce {
	return c.voice.e2eeCopy()
}
