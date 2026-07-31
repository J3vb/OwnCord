package db

import (
	"context"
	"log/slog"
)

// Auditor is the minimal audit-write surface WriteAudit needs. *DB satisfies
// it directly, and the service layer's Store interface does too, so every
// caller — api, admin, ws, service — can route its audit writes through this
// one helper regardless of whether it holds a *DB or a narrower interface.
type Auditor interface {
	LogAudit(ctx context.Context, actorID int64, action, targetType string, targetID int64, detail string) error
}

// AsyncAuditor is the optional asynchronous fast path for WriteAudit. An
// Auditor that also implements it — in practice *DB, once main.go installs
// an AuditWriter via SetAuditWriter — can take the entry off the request
// path. EnqueueAudit reports true when it took responsibility for the entry
// (the background writer may still drop it under load, but never silently —
// see AuditWriter.Enqueue), and false when no writer is installed, in which
// case WriteAudit performs the synchronous best-effort write below. The
// token CLI and tests never install a writer, so they stay synchronous.
type AsyncAuditor interface {
	EnqueueAudit(actorID int64, action, targetType string, targetID int64, detail string) bool
}

// WriteAudit records an audit entry best-effort.
//
// Per the D8 policy decision (docs/plans/audit-2026-07-19-decisions.md), audit
// writes stay best-effort: a LogAudit failure must never fail or abort the
// caller's request. But a failed write must never be silently discarded
// either — this helper logs it with the actor/action/target context so the
// gap is visible in the logs. The detail string is intentionally not logged;
// it can carry request-specific or sensitive text and the structured fields
// already identify what was attempted.
func WriteAudit(ctx context.Context, a Auditor, actorID int64, action, targetType string, targetID int64, detail string) {
	if aa, ok := a.(AsyncAuditor); ok && aa.EnqueueAudit(actorID, action, targetType, targetID, detail) {
		return
	}
	if err := a.LogAudit(ctx, actorID, action, targetType, targetID, detail); err != nil {
		slog.Error("audit log write failed",
			"action", action,
			"actor_id", actorID,
			"target_type", targetType,
			"target_id", targetID,
			"error", err,
		)
	}
}
