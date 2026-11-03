package service

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// accountRecoveryStore is what the recovery kit and the owner-issued recovery
// credential read and write. *db.DB satisfies it.
type accountRecoveryStore interface {
	db.Auditor
	sessionCreator
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetUserByUsername(ctx context.Context, username string) (*db.User, error)
	GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error)
	// Recovery kit.
	UpsertRecoveryKit(ctx context.Context, userID int64, verifier string) error
	GetRecoveryKit(ctx context.Context, userID int64) (*db.RecoveryKit, error)
	RedeemRecoveryKit(ctx context.Context, userID int64, verifier, newPasswordHash, auditAction, auditDetail string) (int64, error)
	// Owner-issued recovery credential.
	UpsertRecoveryAssist(ctx context.Context, userID int64, verifier string, issuedBy int64, verification string, expiresAt time.Time) error
	GetRecoveryAssist(ctx context.Context, userID int64) (*db.RecoveryAssist, error)
	RedeemRecoveryAssist(ctx context.Context, userID int64, verifier, newPasswordHash, auditAction, auditDetail string) (int64, error)
}

// accountRecovery owns the recovery kit and the owner-issued recovery assist.
type accountRecovery struct {
	*authCommon
	// issueMu serializes the two-budget reservation of IssueRecoveryAssist.
	issueMu syncutil.Mutex
	st      accountRecoveryStore
}
