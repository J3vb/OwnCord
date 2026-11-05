package ws

import (
	"github.com/J3vb/OwnCord/Server/db"
)

type voiceStatePayload struct {
	ChannelID int64  `json:"channel_id"`
	UserID    int64  `json:"user_id"`
	Username  string `json:"username"`
	Muted     bool   `json:"muted"`
	Deafened  bool   `json:"deafened"`
	// Speaking is always false on the wire: the column is reset on insert and never
	// updated; LiveKit's ActiveSpeakersChanged is the speaking authority. Kept for
	// protocol compatibility.
	Speaking    bool `json:"speaking"`
	Camera      bool `json:"camera"`
	Screenshare bool `json:"screenshare"`
	// ServerMuted/ServerDeafened are moderator-imposed. Muted/Deafened are always set
	// alongside, so a client ignoring these still renders the user silenced; these
	// let the UI tell a self-mute from one the user may not lift.
	ServerMuted    bool `json:"server_muted"`
	ServerDeafened bool `json:"server_deafened"`
}

// voiceMovedPayload tells one client its moderator moved it to another voice
// channel; it tears down its LiveKit session and re-joins via voice_join.
type voiceMovedPayload struct {
	ToChannelID int64 `json:"to_channel_id"`
	// Reason says why the server moved the client ("afk" for the idle sweep); omitted
	// for a moderator move.
	Reason string `json:"reason,omitempty"`
	// ByUserID is the moderator who made the move; omitted for the AFK sweep (no actor).
	ByUserID int64 `json:"by_user_id,omitempty"`
}

// voiceMovedReasonAFK is voice_moved's reason for a move by the AFK sweep.
const voiceMovedReasonAFK = "afk"

// voiceDisconnectedPayload tells one client a moderator removed it from voice.
type voiceDisconnectedPayload struct {
	ChannelID int64  `json:"channel_id"`
	Reason    string `json:"reason"`
}

type voiceConfigPayload struct {
	ChannelID int64  `json:"channel_id"`
	Quality   string `json:"quality"`
	Bitrate   int    `json:"bitrate"`
	MaxUsers  int    `json:"max_users"`
	// ThresholdMode, MixingThreshold and TopSpeakers are reserved: shipped on every
	// frame but never read by the client, since LiveKit's ActiveSpeakersChanged is
	// authoritative. Kept for protocol compatibility; do not build on them without a reader.
	ThresholdMode   string `json:"threshold_mode"`
	MixingThreshold int    `json:"mixing_threshold"`
	TopSpeakers     int    `json:"top_speakers"`
}

type voiceTokenPayload struct {
	ChannelID   int64  `json:"channel_id"`
	Token       string `json:"token"`
	URL         string `json:"url"`
	DirectURL   string `json:"direct_url,omitempty"`
	IsKeyHolder bool   `json:"is_key_holder"`
}

// voiceE2EEAnnounceBroadcast is the server-to-client relay with user_id added.
// Signature is the sender's identity-key signature over the ephemeral key, relayed
// verbatim and omitted for legacy announces.
type voiceE2EEAnnounceBroadcast struct {
	UserID    int64  `json:"user_id"`
	PublicKey string `json:"public_key"`
	Signature string `json:"signature,omitempty"`
	// VideoDecode is the sender's sanitized decodable video codec list.
	VideoDecode []string `json:"video_decode,omitempty"`
	// IdentityPublicKey is the announcing connection's device identity key, omitted
	// when none was sent. Peers verify Signature against it when present, else the
	// member's published key.
	IdentityPublicKey string `json:"identity_public_key,omitempty"`
	// KeySlots is the sender's key_slots flag, omitted when false.
	KeySlots bool `json:"key_slots,omitempty"`
	// BoundOffers is the sender's bound_offers flag, omitted when false.
	BoundOffers bool `json:"bound_offers,omitempty"`
}

// voiceE2EEOfferRelay is the server-to-client relay with from_user_id.
type voiceE2EEOfferRelay struct {
	FromUserID   int64  `json:"from_user_id"`
	EncryptedKey string `json:"encrypted_key"`
	IV           string `json:"iv"`
}

type voiceLeavePayload struct {
	ChannelID int64 `json:"channel_id"`
	UserID    int64 `json:"user_id"`
}

func buildVoiceState(state db.VoiceState) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceState,
		Payload: voiceStatePayload{
			ChannelID:   state.ChannelID,
			UserID:      state.UserID,
			Username:    state.Username,
			Muted:       state.Muted,
			Deafened:    state.Deafened,
			Speaking:    state.Speaking,
			Camera:      state.Camera,
			Screenshare: state.Screenshare,

			ServerMuted:    state.ServerMuted,
			ServerDeafened: state.ServerDeafened,
		},
	})
}

// buildVoiceMoved constructs voice_moved. reason is "" for a moderator move and
// "afk" for the sweep; byUserID is the moderator, 0 (omitted) for the sweep.
func buildVoiceMoved(toChannelID int64, reason string, byUserID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeVoiceMoved,
		Payload: voiceMovedPayload{ToChannelID: toChannelID, Reason: reason, ByUserID: byUserID},
	})
}

// buildVoiceDisconnected is for the client a moderator removed from voice.
func buildVoiceDisconnected(channelID int64, reason string) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeVoiceDisconnected,
		Payload: voiceDisconnectedPayload{ChannelID: channelID, Reason: reason},
	})
}

func buildVoiceConfig(channelID int64, quality string, bitrate int, maxUsers int) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceConfig,
		Payload: voiceConfigPayload{
			ChannelID:       channelID,
			Quality:         quality,
			Bitrate:         bitrate,
			MaxUsers:        maxUsers,
			ThresholdMode:   "top_speakers",
			MixingThreshold: 0,
			TopSpeakers:     5,
		},
	})
}

// buildVoiceToken constructs voice_token. url is the proxy path ("/livekit");
// direct_url is the raw LiveKit URL for localhost clients. directURL is the
// server's own dial address, so it is sent only when its host is loopback:
// anything else (a docker service name, LiveKit Cloud) may not resolve on the
// client, which then tunnels.
func buildVoiceToken(channelID int64, token string, proxyPath string, directURL string, isKeyHolder bool) []byte { //nolint:unparam // kept configurable for proxy path flexibility
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceToken,
		Payload: voiceTokenPayload{
			ChannelID:   channelID,
			Token:       token,
			URL:         proxyPath,
			DirectURL:   loopbackURLOrEmpty(directURL),
			IsKeyHolder: isKeyHolder,
		},
	})
}

// buildVoiceE2EEAnnounce constructs a voice_e2ee_announce relay; an empty
// signature or video decode list is omitted.
func buildVoiceE2EEAnnounce(userID int64, a e2eeAnnounce) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceE2EEAnnounceBC,
		Payload: voiceE2EEAnnounceBroadcast{
			UserID:            userID,
			PublicKey:         a.key,
			Signature:         a.sig,
			VideoDecode:       a.videoDecode,
			IdentityPublicKey: a.identityKey,
			KeySlots:          a.keySlots,
			BoundOffers:       a.boundOffers,
		},
	})
}

func buildVoiceE2EEOffer(fromUserID int64, encryptedKey, iv string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceE2EEOfferRelay,
		Payload: voiceE2EEOfferRelay{
			FromUserID:   fromUserID,
			EncryptedKey: encryptedKey,
			IV:           iv,
		},
	})
}

func buildVoiceLeave(channelID, userID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeVoiceLeaveBC,
		Payload: voiceLeavePayload{ChannelID: channelID, UserID: userID},
	})
}
