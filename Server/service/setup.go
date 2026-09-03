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

// ErrSetupAlreadyDone is Bootstrap's refusal when a user already exists. It is
// the whole gate: the setup endpoint is unauthenticated, so "no users exist"
// is the only thing standing between it and anyone on the network.
var ErrSetupAlreadyDone = errors.New("setup has already been completed")

// SetupService owns first-run bootstrap: creating the owner account and the
// minimum a fresh server needs to be usable.
//
// The ordering here is a contract, not a sequence of steps that happen to be
// in this order. CreateOwnerIfEmpty is the atomic gate — it checks "no users"
// and inserts in one statement, closing the TOCTOU window a separate
// UserCount-then-insert leaves open. And once that row commits, EVERY
// remaining step is best-effort (OC-0253): the endpoint's gate is "no users
// exist", so a failure reported as an error after the account is created would
// leave it permanently orphaned — every retry would hit the gate and be
// refused forever, with no session, no channels and no invite. Those steps
// become warnings instead, and run detached from the request context so a
// client that disconnects right after the commit cannot take them down.
type SetupService struct {
	st Store
}

// NewSetupService creates a SetupService.
func NewSetupService(st Store) *SetupService {
	return &SetupService{st: st}
}

// ownerRoleID is the role the first account is created with.
const ownerRoleID = 1

// bootstrapInviteUses and bootstrapInviteTTL bound the invite the first run
// mints. It is deliberately not unlimited and not permanent: the owner can
// create whatever they need once they are logged in, and an unbounded invite
// left over from setup is a standing way into the server.
const (
	bootstrapInviteUses = 5
	bootstrapInviteTTL  = 24 * time.Hour
)

// BootstrapInput is the first-run request. Username and Password have already
// been validated by the transport; Device and Host describe the request that
// will own the issued session.
type BootstrapInput struct {
	Username string
	Password string
	Device   string
	Host     string
}

// BootstrapResult is a completed first run. Token is empty when the session
// could not be issued and InviteCode when the invite could not be minted —
// both are reported in Warnings rather than as errors, because the account
// exists either way and the caller must not retry.
type BootstrapResult struct {
	OwnerID    int64
	Token      string
	InviteCode string
	Warnings   []string
}

// SetupCompletedSetting is the durable first-run flag (migration 043): set
// in the same transaction as the first owner and never cleared by the
// server. It, not the user count, is what keeps the unauthenticated setup
// endpoint closed once a server has been set up — an account erasure can
// empty the users table (a marker replay erases past the last-admin guard),
// and that must not reopen it. An operator re-opens the wizard deliberately
// by setting the row back to 0 with filesystem access to the database.
const SetupCompletedSetting = "setup_completed"

// NeedsSetup reports whether the server still needs its first run: the
// durable flag is unset and no account exists. It is advisory — a status
// read for the setup page — and never the gate: Bootstrap's atomic insert,
// which reads the same flag inside its transaction, is.
func (s *SetupService) NeedsSetup(ctx context.Context) (bool, error) {
	switch done, err := s.st.GetSetting(ctx, SetupCompletedSetting); {
	case errors.Is(err, db.ErrNotFound):
		// A database from before the migration: the count decides.
	case err != nil:
		return false, fmt.Errorf("%w: failed to read the setup flag: %w", ErrInternal, err)
	case done == "1":
		return false, nil
	}
	count, err := s.st.UserCount(ctx)
	if err != nil {
		return false, fmt.Errorf("%w: failed to count users: %w", ErrInternal, err)
	}
	return count == 0, nil
}

// Bootstrap creates the owner account and everything a fresh server needs.
// It returns ErrSetupAlreadyDone if any account already exists and ErrInternal
// if the account could not be created; after that point it always succeeds,
// reporting partial failures in Warnings — see the type's doc comment.
func (s *SetupService) Bootstrap(ctx context.Context, in BootstrapInput) (*BootstrapResult, error) {
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to hash password: %w", ErrInternal, err)
	}

	// Atomic check-and-create (BUG-119): a UserCount followed by an insert
	// leaves a window in which two concurrent setup requests both see zero.
	uid, err := s.st.CreateOwnerIfEmpty(ctx, in.Username, hash, ownerRoleID)
	if errors.Is(err, db.ErrConflict) {
		return nil, ErrSetupAlreadyDone
	}
	if err != nil {
		return nil, fmt.Errorf("%w: failed to create user: %w", ErrInternal, err)
	}

	// The account exists from here on. Detach from the request context so a
	// client that navigates away cannot orphan its own new account.
	ctx = context.WithoutCancel(ctx)
	res := &BootstrapResult{OwnerID: uid}
	res.Token = s.issueSetupSession(ctx, uid, in.Device, in.Host, &res.Warnings)
	s.seedDefaultChannels(ctx)
	res.InviteCode = s.mintBootstrapInvite(ctx, uid, &res.Warnings)
	return res, nil
}

// noSessionWarning is what the owner is told when their account exists but no
// session could be started: the account is usable, they just have to log in.
const noSessionWarning = "your account was created, but a login session could not be started automatically — log in with your new credentials"

// issueSetupSession logs the new owner straight in, returning "" and appending
// a warning when it cannot.
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
	if _, err := s.st.CreateSession(ctx, uid, auth.HashToken(token), device, host); err != nil {
		slog.Error("setup: failed to create session", "error", err)
		*warnings = append(*warnings, noSessionWarning)
		return ""
	}
	return token
}

// seedDefaultChannels creates the two channels a fresh server needs to be
// usable at all, under the canonical categories. Failures are ignored rather
// than warned about: an owner who lands in an empty server can make channels
// from the UI, and there is nothing useful to tell them here.
func (s *SetupService) seedDefaultChannels(ctx context.Context) {
	if _, err := s.st.CreateChannel(ctx, "general", "text", "Text Channels", "Welcome to the server!", 0); err != nil {
		slog.Error("setup: failed to create the default text channel", "error", err)
	}
	if _, err := s.st.CreateChannel(ctx, "General", "voice", "Voice Channels", "", 0); err != nil {
		slog.Error("setup: failed to create the default voice channel", "error", err)
	}
}

// mintBootstrapInvite creates the bounded invite the owner can hand out
// immediately, returning "" and appending a warning when it cannot.
func (s *SetupService) mintBootstrapInvite(ctx context.Context, uid int64, warnings *[]string) string {
	expiry := time.Now().Add(bootstrapInviteTTL)
	code, err := s.st.CreateInvite(ctx, uid, bootstrapInviteUses, &expiry)
	if err != nil {
		slog.Error("setup: failed to generate bootstrap invite", "error", err)
		*warnings = append(*warnings,
			"your account was created, but the bootstrap invite could not be generated — create one from the admin panel after logging in")
		return ""
	}
	return code
}

// ApplyWizardSettings persists the setup wizard's database-backed settings in
// one transaction, so a partial write cannot leave the Settings page showing
// values the wizard never applied.
//
// It deliberately does NOT run SettingsService.Patch's request validation: the
// values here are derived by the wizard from its own already-validated payload,
// not supplied as a settings PATCH, and Patch's require_2fa precondition has
// nothing to check on a server with exactly one account. It writes through the
// same atomic apply.
func (s *SetupService) ApplyWizardSettings(ctx context.Context, updates map[string]string) error {
	if len(updates) == 0 {
		return nil
	}
	if err := s.st.ApplySettings(ctx, updates); err != nil {
		return fmt.Errorf("%w: failed to apply wizard settings: %w", ErrInternal, err)
	}
	return nil
}

// RecordSetup writes the server_setup audit row — the first entry in the
// trail, and the only record of who claimed the server.
func (s *SetupService) RecordSetup(ctx context.Context, uid int64, detail string) {
	db.WriteAudit(context.WithoutCancel(ctx), s.st, uid, "server_setup", "server", 0, detail)
}

// RecordConfigWrite writes the config_write audit row for the wizard's
// config.yaml patch. The detail names the keys touched, never their values —
// the patch carries TLS and LiveKit secrets.
func (s *SetupService) RecordConfigWrite(ctx context.Context, uid int64, keys string) {
	db.WriteAudit(context.WithoutCancel(ctx), s.st, uid, "config_write", "server", 0, keys)
}
