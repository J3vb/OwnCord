package ws

// voice_session_admit.go: the signalling proxy's door into voice state. A request is admitted only
// for a current join, and the proxy connects with the credential issued here, not the client's, so
// a session starts with the rights the member holds at that moment.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/livekit/protocol/auth"
)

var (
	ErrVoiceCredentialInvalid = errors.New("voice credential invalid")
	// ErrVoiceSessionRefused: the credential verifies but names no current join.
	ErrVoiceSessionRefused = errors.New("voice session refused")
	// ErrVoiceSessionAbsent: the join is current but the media server holds no participant for it.
	ErrVoiceSessionAbsent = errors.New("voice session not at the media server")
)

// Vars so tests can shorten them.
var (
	voiceAdmitRetryDelay   = 250 * time.Millisecond
	voiceConfirmRetryDelay = 100 * time.Millisecond
)

const voiceConfirmAttempts = 3

// VoiceSessionTicket is one admitted signalling request.
type VoiceSessionTicket struct {
	// Token is the credential the proxy presents to the media server.
	Token string
	// Confirm re-checks the join once the media server holds the session: ErrVoiceSessionRefused
	// when the join ended meanwhile (the session is removed), ErrVoiceSessionAbsent when the media
	// server holds no participant, any other error when the check could not be made. The proxy
	// connects the client only after a nil return.
	Confirm func(ctx context.Context) error
}

type voiceJoinClaim struct {
	userID    int64
	channelID int64
	joinToken string
	name      string
}

// verifyJoinCredential returns the join a credential names. Errors never carry the credential.
func (c *LiveKitClient) verifyJoinCredential(presented string) (voiceJoinClaim, error) {
	verifier, err := auth.ParseAPIToken(presented)
	if err != nil || verifier.APIKey() != c.apiKey {
		return voiceJoinClaim{}, fmt.Errorf("%w: not issued for this server", ErrVoiceCredentialInvalid)
	}
	_, claims, err := verifier.Verify(c.apiSecret)
	if err != nil || claims == nil {
		return voiceJoinClaim{}, fmt.Errorf("%w: verification failed", ErrVoiceCredentialInvalid)
	}
	if claims.Video == nil || !claims.Video.RoomJoin {
		return voiceJoinClaim{}, fmt.Errorf("%w: not a room credential", ErrVoiceSessionRefused)
	}
	channelID, err := parseRoomChannelID(claims.Video.Room)
	if err != nil {
		return voiceJoinClaim{}, fmt.Errorf("%w: not a voice channel room", ErrVoiceSessionRefused)
	}
	userID, joinToken, err := parseParticipantIdentity(claims.Identity)
	if err != nil || joinToken == "" {
		return voiceJoinClaim{}, fmt.Errorf("%w: identity names no join", ErrVoiceSessionRefused)
	}
	return voiceJoinClaim{userID: userID, channelID: channelID, joinToken: joinToken, name: claims.Name}, nil
}

// AdmitVoiceSession decides whether a signalling request may open a media session. It takes no
// lock. A failed membership read is retried once, then returned: the caller answers "try again",
// never "admitted".
func (h *Hub) AdmitVoiceSession(ctx context.Context, presented string) (VoiceSessionTicket, error) {
	if h.livekit == nil || h.voice == nil {
		return VoiceSessionTicket{}, errors.New("voice not configured")
	}
	claim, err := h.livekit.verifyJoinCredential(presented)
	if err != nil {
		return VoiceSessionTicket{}, err
	}
	grants, live, err := h.sessionVoiceGrants(ctx, claim.userID, claim.channelID, claim.joinToken)
	if err != nil {
		select {
		case <-ctx.Done():
			return VoiceSessionTicket{}, fmt.Errorf("admitting voice session: %w", ctx.Err())
		case <-time.After(voiceAdmitRetryDelay):
		}
		grants, live, err = h.sessionVoiceGrants(ctx, claim.userID, claim.channelID, claim.joinToken)
	}
	if err != nil {
		return VoiceSessionTicket{}, fmt.Errorf("admitting voice session: %w", err)
	}
	if !live {
		slog.Info("voice session: refused, no current join",
			"user_id", claim.userID, "channel_id", claim.channelID)
		return VoiceSessionTicket{}, fmt.Errorf("%w: no current join", ErrVoiceSessionRefused)
	}
	token, err := h.livekit.GenerateToken(claim.userID, claim.name, claim.channelID, claim.joinToken,
		grants.microphone, grants.camera, grants.screenshare)
	if err != nil {
		return VoiceSessionTicket{}, fmt.Errorf("admitting voice session: %w", err)
	}
	return VoiceSessionTicket{
		Token: token,
		Confirm: func(ctx context.Context) error {
			return h.confirmVoiceSession(ctx, claim)
		},
	}, nil
}

// confirmVoiceSession runs after the media server accepted the session and before the client is
// connected to it. It holds the member's moderation lock and applies the current rights whether or
// not they moved: the answer shows the media server holds the participant, and every moderation
// write takes the same lock, so a later one reaches it. A participant the media server does not
// hold yet is waited for briefly, then reported as ErrVoiceSessionAbsent, never as confirmed.
func (h *Hub) confirmVoiceSession(ctx context.Context, claim voiceJoinClaim) error {
	unlock := h.voiceHub.mod.Lock(claim.userID)
	defer unlock()
	grants, live, err := h.sessionVoiceGrants(ctx, claim.userID, claim.channelID, claim.joinToken)
	if err != nil {
		return fmt.Errorf("confirming voice session: %w", err)
	}
	if !live {
		if rmErr := h.livekit.RemoveParticipant(ctx, claim.channelID, claim.userID, claim.joinToken); rmErr != nil && !liveKitParticipantMissing(rmErr) {
			slog.Warn("voice session: removing a session whose join ended failed",
				"err", rmErr, "user_id", claim.userID, "channel_id", claim.channelID)
		}
		slog.Info("voice session: refused, join ended while connecting",
			"user_id", claim.userID, "channel_id", claim.channelID)
		return fmt.Errorf("%w: join ended while connecting", ErrVoiceSessionRefused)
	}
	for attempt := 1; ; attempt++ {
		err = h.livekit.updateParticipantPublishing(ctx, claim.channelID, claim.userID, claim.joinToken,
			grants.microphone, grants.camera, grants.screenshare)
		if err == nil {
			return nil
		}
		if !liveKitParticipantMissing(err) {
			return fmt.Errorf("confirming voice session: %w", err)
		}
		if attempt == voiceConfirmAttempts {
			return fmt.Errorf("%w: %w", ErrVoiceSessionAbsent, err)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("confirming voice session: %w", ctx.Err())
		case <-time.After(voiceConfirmRetryDelay):
		}
	}
}
