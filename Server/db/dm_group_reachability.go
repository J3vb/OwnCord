package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// groupReachabilityQuery is one read answering "may actor put any of these
// targets in a group": 1 when some target has turned direct messages from
// members off and holds no trust row for the actor, or when the actor holds a
// message request to some target that the target has not accepted (no trust
// row; pending, ignored, deleted and blocked all count). The placeholders are
// the target ids (twice) and the actor id (twice); only "?" is concatenated.
func groupReachabilityQuery(n int) string {
	marks := strings.TrimSuffix(strings.Repeat("?,", n), ",")
	return `SELECT EXISTS (
	  SELECT 1 FROM user_privacy up
	   WHERE up.user_id IN (` + marks + `) AND up.allow_member_dms = 0
	     AND NOT EXISTS (SELECT 1 FROM trusted_senders ts
	                      WHERE ts.recipient_id = up.user_id AND ts.sender_id = ?)
	  UNION ALL
	  SELECT 1 FROM message_requests mr
	   WHERE mr.sender_id = ? AND mr.recipient_id IN (` + marks + `)
	     AND NOT EXISTS (SELECT 1 FROM trusted_senders ts
	                      WHERE ts.recipient_id = mr.recipient_id AND ts.sender_id = mr.sender_id))`
}

func groupReachabilityArgs(actorID int64, targets []int64) []any {
	args := make([]any, 0, 2*len(targets)+2)
	for _, id := range targets {
		args = append(args, id)
	}
	args = append(args, actorID, actorID)
	for _, id := range targets {
		args = append(args, id)
	}
	return args
}

// rowQuerier is the one read both a transaction and the reader pool offer.
type rowQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func groupTargetsRefused(ctx context.Context, q rowQuerier, actorID int64, targets []int64) (bool, error) {
	if len(targets) == 0 {
		return false, nil
	}
	var refused bool
	//nolint:gosec // G202: only "?" placeholders are concatenated, ids are bound
	if err := q.QueryRowContext(ctx, groupReachabilityQuery(len(targets)), groupReachabilityArgs(actorID, targets)...).Scan(&refused); err != nil {
		return false, fmt.Errorf("check group reachability: %w", err)
	}
	return refused, nil
}

// GroupDMTargetsRefuse reports whether actorID may not put some user in
// targets into a group DM, whether by creating one with them or adding them.
// A target refuses when it has turned off direct messages from members and does
// not trust the actor, or when the actor holds a message request to it that it
// has not accepted. Only the actor's trust counts, never that of the people
// already in a group.
func (d *DB) GroupDMTargetsRefuse(ctx context.Context, actorID int64, targets []int64) (bool, error) {
	return groupTargetsRefused(ctx, d, actorID, targets)
}

// requireReachableTargets returns ErrGroupDMBlockedPair when any of targets
// refuses actorID as GroupDMTargetsRefuse describes, read on the transaction
// so a setting changed since the service's check is seen.
func requireReachableTargets(ctx context.Context, tx *sql.Tx, actorID int64, targets []int64) error {
	refused, err := groupTargetsRefused(ctx, tx, actorID, targets)
	if err != nil {
		return err
	}
	if refused {
		return ErrGroupDMBlockedPair
	}
	return nil
}
