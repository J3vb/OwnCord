package service

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// MentionCountNotifier delivers a live mention_count frame to one reader whose
// read_states.mention_count changed (DP-27). channelID names the channel and
// count is the reader's total after the bump.
type MentionCountNotifier interface {
	NotifyMentionCount(userID, channelID, count int64)
}

// SetMentionNotifier installs the live unread-badge hook (DP-27). The ws layer
// calls this once, in NewHub, with the hub's implementation; passing nil (or
// never calling it) leaves the hook off.
func (s *MessageService) SetMentionNotifier(n MentionCountNotifier) {
	s.mentionNotifier = n
}

// notifyMentionBumped pushes the badge updates for one flush's changed readers
// (the no-worker fallback path). It reads the hook at call time, so a notifier
// installed after SendMessage still receives the frame.
func (s *MessageService) notifyMentionBumped(channelID int64, bumped map[int64]int64) {
	if s.mentionNotifier == nil {
		return
	}
	emitMentionBumped(s.mentionNotifier.NotifyMentionCount, channelID, bumped)
}

// reverseMentionCounts lowers the mention_count bumps msgIDs made and pushes
// each admitted reader their new total, holding the shared mentionEmitMu lock
// across both the write and the frame. That lock is what makes the badge frames
// ordered (DP-27 ordering): the mention worker's coalesced increment holds the
// same lock across its write and frame, so a reader's last frame always carries
// the latest committed total, and a delete inside the coalesce window can never
// be overtaken by an older increment total. A failed reversal emits nothing, so
// a reader keeps the total it already has.
func (s *MessageService) reverseMentionCounts(ctx context.Context, channelID int64, msgIDs []int64) error {
	s.mentionEmitMu.Lock()
	defer s.mentionEmitMu.Unlock()
	lowered, err := s.st.DecrementMentionCounts(ctx, channelID, msgIDs)
	if err != nil {
		return err
	}
	s.notifyMentionBumped(channelID, lowered)
	return nil
}

// emitIncrement writes one channel's coalesced mention increment and pushes its
// frames, holding mentionEmitMu across both so an increment frame is never
// overtaken by a later decrement (and vice versa). It is the no-worker fallback
// path; the bounded worker's flush holds the same lock (mentionWorker.emitMu).
func (s *MessageService) emitIncrement(ctx context.Context, channelID int64, entries []db.MentionBatchEntry) {
	s.mentionEmitMu.Lock()
	defer s.mentionEmitMu.Unlock()
	bumped, err := s.st.IncrementMentionCountsBatch(ctx, channelID, entries)
	if err != nil {
		slog.Error("MessageService.mention fan-out IncrementMentionCounts", "err", err, "channel_id", channelID)
		return
	}
	s.notifyMentionBumped(channelID, bumped)
}

// dispatchMentionBadges routes one message's mention-badge job: to the bounded
// worker when one is running (production), or inline through bg otherwise
// (tests, and any caller built via NewMessageService directly), so a directly
// constructed service still has its counts readable right after a send.
func (s *MessageService) dispatchMentionBadges(bgCtx context.Context, job mentionJob) {
	if w := s.mentionWorkerForSend(); w != nil {
		// Production: hand the job to the single bounded worker on the caller's
		// goroutine. Enqueue never blocks, so no goroutine is spawned per send.
		w.enqueue(job)
		return
	}
	s.bg(func() {
		entries := job.apply(bgCtx)
		if len(entries) == 0 {
			return
		}
		s.emitIncrement(bgCtx, job.channelID, entries)
	})
}
