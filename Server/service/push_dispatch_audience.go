package service

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// coalesceAudience narrows userIDs (the users who hold a push subscription,
// already past prefilterAudience's in-memory filters) to the users a push is
// actually sent to: not the author, currently eligible (offline and permitted
// -- see eligibleFor) and trusting the author if this is a one-to-one DM (see
// below).
//
// Eligibility is checked BEFORE coalescing, not after: an online or
// unauthorized candidate must not reserve the 60s window for a channel they
// were never going to be pushed about, or a later, genuinely eligible
// mention (the recipient came back online, or a mention five seconds after
// an ineligible one) would silently receive nothing. Eligibility is
// re-checked again immediately before every delivery attempt in
// stillEligible, because a bounded but potentially slow dispatch (retries,
// a worker pool) can take long enough for it to change again in the other
// direction.
//
// For a DM, permission IS participation (permissions.CanViewChannel checks
// only DMParticipant for a "dm" channel). Notify already refused a group DM
// before this is ever called (ch.Type == "dm" here always means one-to-one),
// so a DM push additionally requires that the candidate trusts the author --
// the same trusted_senders row Message Requests gates on and DMAudience /
// MessageRequestService.DMDeliveryAudience apply to chat_message delivery
// (service/message_crud.go, service/message_request.go) -- so a first-contact
// message from an unknown sender cannot ring a stranger's phone before they
// have decided to accept it. Fail closed: a lookup error is treated as
// untrusted, same as every other fail-closed check in this file.
func (d *PushDispatcher) coalesceAudience(ctx context.Context, ch *db.Channel, userIDs []int64, authorID int64) []int64 {
	out := make([]int64, 0, len(userIDs))
	for _, uid := range userIDs {
		if uid == authorID || !d.eligibleFor(ctx, ch, uid) || !d.trustsAuthor(ctx, ch, uid, authorID) {
			continue
		}
		out = append(out, uid)
	}
	return out
}

// prefilterAudience is the in-memory half of the audience: distinct, not the
// author, not a blocker of the author, not connected (their client already has
// the message) and not inside their coalescing window for the channel. It
// reads no store.
func (d *PushDispatcher) prefilterAudience(candidateIDs []int64, authorID, channelID int64, blockedByAuthor map[int64]bool) []int64 {
	seen := make(map[int64]bool, len(candidateIDs))
	out := make([]int64, 0, len(candidateIDs))
	now := time.Now()
	for _, uid := range candidateIDs {
		if uid == authorID || uid <= 0 || seen[uid] || blockedByAuthor[uid] {
			continue
		}
		seen[uid] = true
		if d.online != nil && d.online(uid) || d.recentlySent(uid, channelID, now) {
			continue
		}
		out = append(out, uid)
	}
	return out
}

// subscribedUserIDs lists the distinct users of subs in order.
func subscribedUserIDs(subs []db.PushSubscriptionForDispatch) []int64 {
	seen := make(map[int64]bool, len(subs))
	out := make([]int64, 0, len(subs))
	for _, sub := range subs {
		if !seen[sub.UserID] {
			seen[sub.UserID] = true
			out = append(out, sub.UserID)
		}
	}
	return out
}
