package service

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// coalesceAudience narrows userIDs (push subscribers already past
// prefilterAudience) to the users a push is actually sent to: not the author,
// currently eligible (offline and permitted, see eligibleFor) and, for a
// one-to-one DM, trusting the author.
// Eligibility is checked BEFORE coalescing: an online or unauthorized candidate
// must not reserve the 60s window for a channel they were never pushed about, or a
// later genuinely eligible mention would silently get nothing. It is re-checked
// before every delivery attempt in stillEligible, since a slow dispatch (retries,
// worker pool) can outlast it.
// For a DM, permission IS participation (permissions.CanViewChannel checks only
// DMParticipant). Notify already refused a group DM, so "dm" here is one-to-one and
// a push additionally requires the candidate trusts the author (the trusted_senders
// row Message Requests gates on, as DMAudience applies to chat_message delivery),
// so a first-contact message cannot ring a stranger's phone before they accept it.
// Fail closed: a lookup error counts as untrusted.
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
