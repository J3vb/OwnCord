package service

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

type accountRecoveryStore interface {
	db.Auditor
	sessionCreator
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetUserByUsername(ctx context.Context, username string) (*db.User, error)
	GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error)
	UpsertRecoveryKit(ctx context.Context, userID int64, verifier string) error
	GetRecoveryKit(ctx context.Context, userID int64) (*db.RecoveryKit, error)
	RedeemRecoveryKit(ctx context.Context, userID int64, verifier, newPasswordHash, auditAction, auditDetail string) (int64, error)
	UpsertRecoveryAssist(ctx context.Context, userID int64, verifier string, issuedBy int64, verification string, expiresAt time.Time) error
	GetRecoveryAssist(ctx context.Context, userID int64) (*db.RecoveryAssist, error)
	RedeemRecoveryAssist(ctx context.Context, userID int64, verifier, newPasswordHash, auditAction, auditDetail string) (int64, error)
}

type accountRecovery struct {
	*authCommon
	// issueMu serializes IssueRecoveryAssist's two-budget reservation.
	issueMu syncutil.Mutex
	st      accountRecoveryStore
}
