package db

import "log/slog"

// Auditor is the minimal audit-write surface WriteAudit needs. *DB satisfies
// it directly, and the service layer's Store interface does too, so every
// caller — api, admin, ws, service — can route its audit writes through this
// one helper regardless of whether it holds a *DB or a narrower interface.
type Auditor interface {
	LogAudit(actorID int64, action, targetType string, targetID int64, detail string) error
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
func WriteAudit(a Auditor, actorID int64, action, targetType string, targetID int64, detail string) {
	if err := a.LogAudit(actorID, action, targetType, targetID, detail); err != nil {
		slog.Error("audit log write failed",
			"action", action,
			"actor_id", actorID,
			"target_type", targetType,
			"target_id", targetID,
			"error", err,
		)
	}
}
