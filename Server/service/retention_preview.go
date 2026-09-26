package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// RetentionChange is a single edit, not a replacement for other admins' work.
type RetentionChange = db.RetentionChange

const retentionPreviewLifetime = 15 * time.Minute

// ProposedRetentionPreview is an observation, not a promise about the next
// sweep: new messages, pins and elapsed time can change the eventual count.
type ProposedRetentionPreview struct {
	*db.RetentionChangeEffect
	Proposed         RetentionChange `json:"proposed"`
	ObservedAt       string          `json:"observed_at"`
	Token            string          `json:"token"`
	WouldDelete      int64           `json:"would_delete"`
	AffectedChannels int             `json:"affected_channels"`
	Pinned           int64           `json:"protected_pinned"`
	Indefinite       int64           `json:"protected_indefinite"`
}

type retentionPreviewClaim struct {
	ActorID    int64           `json:"actor_id"`
	Proposed   RetentionChange `json:"proposed"`
	Revision   string          `json:"revision"`
	ObservedAt time.Time       `json:"observed_at"`
}

func validateRetentionChange(c RetentionChange) error {
	if (c.Scope != "server" && c.Scope != "channel") ||
		(c.Scope == "server" && (c.ChannelID != 0 || c.Days == nil)) ||
		(c.Scope == "channel" && c.ChannelID <= 0) {
		return fmt.Errorf("%w: specify a server window or a channel override (null days removes the override)", ErrBadRequest)
	}
	if c.Days != nil && (*c.Days < 0 || *c.Days > RetentionMaxDays) {
		return fmt.Errorf("%w: days must be 0 (keep forever) or between 1 and %d", ErrBadRequest, RetentionMaxDays)
	}
	return nil
}

// PreviewChange binds the server-computed observation to the exact proposal,
// actor and base revision. A stale editor must reload before previewing again.
func (s *RetentionService) PreviewChange(ctx context.Context, actorID int64, c RetentionChange, revision string) (*ProposedRetentionPreview, error) {
	if err := validateRetentionChange(c); err != nil {
		return nil, err
	}
	if revision == "" {
		return nil, fmt.Errorf("%w: reload the retention policy before previewing", ErrBadRequest)
	}
	observed := s.now().UTC()
	effect, err := s.st.PreviewRetentionChange(ctx, c, revision, observed)
	if err != nil {
		return nil, retentionChangeError(err)
	}
	claim := retentionPreviewClaim{ActorID: actorID, Proposed: c, Revision: revision, ObservedAt: observed}
	payload, err := json.Marshal(claim)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	token := base64.RawURLEncoding.EncodeToString(payload) + "." + s.signRetentionPreview(payload)
	out := &ProposedRetentionPreview{RetentionChangeEffect: effect, Proposed: c, ObservedAt: observed.Format(time.RFC3339), Token: token}
	for _, ch := range effect.Channels {
		out.WouldDelete += ch.WouldDelete
		out.Pinned += ch.ProtectedPinned
		out.Indefinite += ch.ProtectedIndefinite
		if ch.WouldDelete > 0 {
			out.AffectedChannels++
		}
	}
	return out, nil
}

func (s *RetentionService) signRetentionPreview(payload []byte) string {
	mac := hmac.New(sha256.New, s.previewKey[:])
	_, _ = mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *RetentionService) retentionClaim(actorID int64, c RetentionChange, token string) (*retentionPreviewClaim, error) {
	invalid := fmt.Errorf("%w: preview this exact change again before applying it (preview missing, changed or expired)", ErrBadRequest)
	if len(token) > 4096 {
		return nil, invalid
	}
	encoded, signature, ok := strings.Cut(token, ".")
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if !ok || err != nil || !hmac.Equal([]byte(signature), []byte(s.signRetentionPreview(payload))) {
		return nil, invalid
	}
	var claim retentionPreviewClaim
	if err := json.Unmarshal(payload, &claim); err != nil {
		return nil, invalid
	}
	if claim.ActorID != actorID || claim.Proposed.Scope != c.Scope || claim.Proposed.ChannelID != c.ChannelID ||
		(claim.Proposed.Days == nil) != (c.Days == nil) ||
		(c.Days != nil && *claim.Proposed.Days != *c.Days) {
		return nil, invalid
	}
	age := s.now().Sub(claim.ObservedAt)
	if age < 0 || age > retentionPreviewLifetime {
		return nil, invalid
	}
	return &claim, nil
}

// ApplyChange is reached only after the admin middleware resolves the live
// bearer/session and MANAGE_SERVER permission again. A preview is not an
// authorization grant. The store compares the revision and writes atomically.
func (s *RetentionService) ApplyChange(ctx context.Context, actorID int64, c RetentionChange, token string) error {
	if err := validateRetentionChange(c); err != nil {
		return err
	}
	claim, err := s.retentionClaim(actorID, c, token)
	if err != nil {
		return err
	}
	detail, err := s.st.ApplyRetentionChange(ctx, actorID, c, claim.Revision)
	if err != nil {
		return retentionChangeError(err)
	}
	action, target := "channel_retention_change", "channel"
	if c.Scope == "server" {
		action, target = "retention_policy_change", "setting"
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, action, target, c.ChannelID,
		detail+"; preview observed at "+claim.ObservedAt.Format(time.RFC3339)+"; revision "+claim.Revision)
	return nil
}

func retentionChangeError(err error) error {
	switch {
	case errors.Is(err, db.ErrConflict):
		return fmt.Errorf("%w: retention policy changed since you loaded it. Reload the policy and preview your change again; nothing was saved", ErrConflict)
	case errors.Is(err, db.ErrNotFound):
		return fmt.Errorf("%w: channel or retention override no longer exists", ErrNotFound)
	case errors.Is(err, db.ErrRetentionProtectedChannel):
		return fmt.Errorf("%w: %w", ErrBadRequest, err)
	default:
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
}
