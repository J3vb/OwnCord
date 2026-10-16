package service

import "fmt"

// reasonMaxRunes bounds the moderator-action ledger's free-text reason (S6
// storage exhaustion, and the same shape the audit detail denylist expects
// of every free-text field): 500 runes, no control characters. Applies to
// warning and timeout, whose reason is shown to the TARGET — the audit row
// itself never carries it (a fixed phrase instead; see Warn).
const reasonMaxRunes = 500

// validateActionReason is warning/timeout's shared reason-shape rule.
func validateActionReason(reason string) error {
	if len([]rune(reason)) > reasonMaxRunes {
		return fmt.Errorf("%w: reason is too long", ErrBadRequest)
	}
	if hasControlChar(reason) {
		return fmt.Errorf("%w: reason contains control characters", ErrBadRequest)
	}
	return nil
}

// requireHumanActor is workstream 10's absence-proof guard, repeated at the
// top of every ModerationService action method before any other check: no
// plugin capability or automated caller can pass a non-positive actor id and
// have it land on the ledger (Server/db's recordModerationAction/
// recordLedgerRow repeat the same guard at the transaction, since that is
// the one place every kind funnels through — this is the service-boundary
// half). Deliberately NOT a schema CHECK (docs: erasure sets actor_id to 0
// for an erased moderator, and a constraint would forbid that transition).
func requireHumanActor(actorID int64) error {
	if actorID <= 0 {
		return fmt.Errorf("%w: a moderation action requires a human actor", ErrForbidden)
	}
	return nil
}
