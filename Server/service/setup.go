package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// ErrSetupAlreadyDone is Bootstrap's refusal when a user exists. It is the whole gate: the setup endpoint is
// unauthenticated, so "no users exist" is all that stands between it and anyone on the network.
var ErrSetupAlreadyDone = errors.New("setup has already been completed")

type setupStore interface {
	db.Auditor
	CreateChannel(ctx context.Context, name, chanType, category, topic string, position int) (int64, error)
	CreateOwnerIfEmpty(ctx context.Context, username, passwordHash string, roleID int) (int64, error)
	UpsertRecoveryKit(ctx context.Context, userID int64, verifier string) error
	CreateFirstSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error)
	CreateInvite(ctx context.Context, createdBy int64, maxUses int, expiresAt *time.Time) (string, error)
	UserCount(ctx context.Context) (int64, error)
	GetSetting(ctx context.Context, key string) (string, error)
	ApplySettings(ctx context.Context, updates map[string]string) error
}

// SetupService owns first-run bootstrap: the owner account and the minimum a fresh server needs. The ordering
// is a contract. CreateOwnerIfEmpty is the atomic gate (checks "no users" and inserts in one statement,
// closing the TOCTOU window of a separate count-then-insert). Once that row commits, EVERY remaining step is
// best-effort: an error after the account exists would orphan it forever (every retry refused, no session,
// channels or invite). Those steps become warnings and run detached from the request context so a disconnect
// after the commit cannot take them down.
type SetupService struct {
	st      setupStore
	limiter *auth.RateLimiter
}

// NewSetupService creates a SetupService.
func NewSetupService(st setupStore, limiter *auth.RateLimiter) *SetupService {
	return &SetupService{st: st, limiter: limiter}
}

const ownerRoleID = 1

// bootstrapInviteUses/TTL bound the first-run invite: a leftover unbounded invite is a standing way in.
const (
	bootstrapInviteUses = 5
	bootstrapInviteTTL  = 24 * time.Hour
)

// BootstrapInput is the first-run request; Username and Password are validated by the transport. RecoveryKit
// asks for the owner's recovery kit, because a lockout with no kit is the one failure an owner cannot fix
// from inside the server; shown once, only its verifier is stored.
type BootstrapInput struct {
	Username    string
	Password    string
	Device      string
	Host        string
	RecoveryKit bool
}

// BootstrapResult is a completed first run. Token is empty when the session could not be issued and
// InviteCode when the invite could not be minted; both go in Warnings, not errors, because the account exists
// and the caller must not retry. RecoveryKitSecret is shown once.
type BootstrapResult struct {
	OwnerID           int64
	Token             string
	InviteCode        string
	Warnings          []string
	RecoveryKitSecret string
}

// SetupCompletedSetting is the durable first-run flag, set in the first owner's transaction and never cleared
// by the server. It, not the user count, keeps the unauthenticated setup endpoint closed: an account erasure
// can empty the users table and must not reopen it. An operator re-opens the wizard by setting the row to 0.
const SetupCompletedSetting = db.SetupCompletedKey

// NeedsSetup reports whether the server needs its first run: the flag is unset and no account
// exists. Advisory (status page only); the gate is Bootstrap's atomic CreateOwnerIfEmpty.
func (s *SetupService) NeedsSetup(ctx context.Context) (bool, error) {
	switch done, err := s.st.GetSetting(ctx, SetupCompletedSetting); {
	case errors.Is(err, db.ErrNotFound):
	case err != nil:
		return false, fmt.Errorf("%w: failed to read the setup flag: %w", ErrInternal, err)
	case done != db.SetupOpen:
		return false, nil
	}
	count, err := s.st.UserCount(ctx)
	if err != nil {
		return false, fmt.Errorf("%w: failed to count users: %w", ErrInternal, err)
	}
	return count == 0, nil
}

// Bootstrap creates the owner account and everything a fresh server needs. Returns ErrSetupAlreadyDone if any
// account exists and ErrInternal if the account could not be created; after that it succeeds, reporting
// partial failures in Warnings.
func (s *SetupService) Bootstrap(ctx context.Context, in BootstrapInput) (*BootstrapResult, error) {
	needs, err := s.NeedsSetup(ctx)
	if err != nil {
		return nil, err
	}
	if !needs {
		return nil, ErrSetupAlreadyDone
	}

	hash, err := s.hashPassword(ctx, in.Password)
	if err != nil {
		return nil, err
	}

	uid, err := s.st.CreateOwnerIfEmpty(ctx, in.Username, hash, ownerRoleID)
	if errors.Is(err, db.ErrConflict) {
		return nil, ErrSetupAlreadyDone
	}
	if err != nil {
		return nil, fmt.Errorf("%w: failed to create user: %w", ErrInternal, err)
	}

	ctx = context.WithoutCancel(ctx)
	res := &BootstrapResult{OwnerID: uid}
	res.Token = s.issueSetupSession(ctx, uid, in.Device, in.Host, &res.Warnings)
	s.seedDefaultChannels(ctx)
	res.InviteCode = s.mintBootstrapInvite(ctx, uid, &res.Warnings)
	if in.RecoveryKit {
		res.RecoveryKitSecret = s.issueRecoveryKitAtSetup(ctx, uid, &res.Warnings)
	}
	return res, nil
}

func (s *SetupService) hashPassword(ctx context.Context, password string) (string, error) {
	if s.limiter != nil {
		release, retryAfter, ok := s.limiter.Admission().Acquire(ctx, auth.AdmissionWait)
		defer release()
		if !ok {
			return "", &authBusyError{retryAfter}
		}
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return "", fmt.Errorf("%w: failed to hash password: %w", ErrInternal, err)
	}
	return hash, nil
}

func (s *SetupService) issueRecoveryKitAtSetup(ctx context.Context, uid int64, warnings *[]string) string {
	shown, canonical, err := auth.GenerateRecoveryKitSecret()
	if err != nil {
		slog.Error("setup: failed to generate the recovery kit", "error", err)
		*warnings = append(*warnings, recoveryKitSetupWarning)
		return ""
	}
	verifier, err := auth.HashRecoveryKitSecret(canonical)
	if err != nil {
		slog.Error("setup: failed to hash the recovery kit", "error", err)
		*warnings = append(*warnings, recoveryKitSetupWarning)
		return ""
	}
	if err := s.st.UpsertRecoveryKit(ctx, uid, verifier); err != nil {
		slog.Error("setup: failed to store the recovery kit", "error", err)
		*warnings = append(*warnings, recoveryKitSetupWarning)
		return ""
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, uid, "recovery_kit_issued", "user", uid,
		"recovery kit issued at setup")
	return shown
}

const recoveryKitSetupWarning = "your account was created, but the recovery kit could not be generated — create one later in the OwnCord desktop client under Settings"

const noSessionWarning = "your account was created, but a login session could not be started automatically — log in with your new credentials"

func (s *SetupService) issueSetupSession(ctx context.Context, uid int64, device, host string, warnings *[]string) string {
	token, err := auth.GenerateToken()
	if err != nil {
		slog.Error("setup: failed to generate session token", "error", err)
		*warnings = append(*warnings, noSessionWarning)
		return ""
	}
	const maxDeviceLen = 512
	if len(device) > maxDeviceLen {
		device = device[:maxDeviceLen]
	}
	if _, err := s.st.CreateFirstSession(ctx, uid, auth.HashToken(token), device, host); err != nil {
		slog.Error("setup: failed to create session", "error", err)
		*warnings = append(*warnings, noSessionWarning)
		return ""
	}
	return token
}

func (s *SetupService) seedDefaultChannels(ctx context.Context) {
	if _, err := s.st.CreateChannel(ctx, "general", "text", "Text Channels", "Welcome to the server!", 0); err != nil {
		slog.Error("setup: failed to create the default text channel", "error", err)
	}
	if _, err := s.st.CreateChannel(ctx, "General", "voice", "Voice Channels", "", 0); err != nil {
		slog.Error("setup: failed to create the default voice channel", "error", err)
	}
}

func (s *SetupService) mintBootstrapInvite(ctx context.Context, uid int64, warnings *[]string) string {
	expiry := time.Now().Add(bootstrapInviteTTL)
	code, err := s.st.CreateInvite(ctx, uid, bootstrapInviteUses, &expiry)
	if err != nil {
		slog.Error("setup: failed to generate bootstrap invite", "error", err)
		*warnings = append(*warnings,
			"your account was created, but the bootstrap invite could not be generated — create one in the OwnCord desktop client with the “Invite people” action in the server sidebar")
		return ""
	}
	return code
}

// ApplyWizardSettings persists the wizard's database-backed settings in one transaction, so a partial write
// cannot leave Settings showing values the wizard never applied. It skips SettingsService.Patch's validation:
// the values derive from the wizard's own validated payload, and Patch's require_2fa precondition has nothing
// to check with one account.
func (s *SetupService) ApplyWizardSettings(ctx context.Context, updates map[string]string) error {
	if len(updates) == 0 {
		return nil
	}
	if err := s.st.ApplySettings(ctx, updates); err != nil {
		return fmt.Errorf("%w: failed to apply wizard settings: %w", ErrInternal, err)
	}
	return nil
}

// RecordSetup writes the server_setup audit row: the first entry in the trail and the only record
// of who claimed the server.
func (s *SetupService) RecordSetup(ctx context.Context, uid int64, detail string) {
	db.WriteAudit(context.WithoutCancel(ctx), s.st, uid, "server_setup", "server", 0, detail)
}

// RecordConfigWrite writes the config_write audit row for the wizard's config.yaml patch.
// The detail names keys, never values: the patch carries TLS and LiveKit secrets.
func (s *SetupService) RecordConfigWrite(ctx context.Context, uid int64, keys string) {
	db.WriteAudit(context.WithoutCancel(ctx), s.st, uid, "config_write", "server", 0, keys)
}
