package service

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// Timing of the call log worker. A call ends callEndGrace after its room
// empties, so a quick rejoin is the same call. Notes are coalesced for
// callLogCoalesce before a reconcile, and callLogTick is the period of the
// level-triggered pass that heals a missed note and refreshes last_seen_at.
const (
	callLogCoalesce = 2 * time.Second
	callLogTick     = 60 * time.Second
	callEndGrace    = 10 * time.Second
)

// CallLogStore is the data access the call log worker needs beyond the reads
// the rest of Store already offers (channel, voice states, DM delivery
// targets, user and role). *db.DB satisfies it; Store embeds it.
type CallLogStore interface {
	CreateCallLog(ctx context.Context, p db.CallLogParams) (*db.CallLogRow, error)
	EndCall(ctx context.Context, messageID int64, endedAt, content string) (bool, error)
	ListOpenCalls(ctx context.Context) ([]db.OpenCall, error)
	GetOpenCall(ctx context.Context, channelID int64) (*db.OpenCall, error)
	AddCallParticipants(ctx context.Context, messageID int64, userIDs []int64) error
	TouchCall(ctx context.Context, messageID int64, seenAt string) error
	GetCallInfo(ctx context.Context, messageID int64) (*db.CallInfo, error)
}

// CallLogEvent is what the sink needs to build the frames for one call log
// row. Author and AuthorRole are set only on a created row. Audience is who
// the DM frame goes to (the same rule as a chat message from the author).
type CallLogEvent struct {
	MessageID  int64
	ChannelID  int64
	Author     *db.User
	AuthorRole string
	Content    string
	Timestamp  string
	Call       db.CallInfo
	Audience   []int64
	// Reopens are the DMs reopened for a recipient, announced ahead of the row.
	Reopens []RingReopen
}

// CallLogSink delivers a call log row to connected clients. The hub
// implements it. The worker holds no lock while it calls the sink.
type CallLogSink interface {
	CallLogCreated(ctx context.Context, ev CallLogEvent)
	CallLogEnded(ctx context.Context, ev CallLogEvent)
}

// callLogPending is what the notes recorded for one channel since the last
// reconcile: the first note time per joiner and the latest leave.
type callLogPending struct {
	joiners   map[int64]time.Time
	lastLeave time.Time
}

// CallLogService derives one message row per DM call from voice presence
// (WP 3B-9). Voice joins and leaves only post notes; a single worker goroutine
// owns every write and reconciles the voice_states rows of a channel with its
// live call row, so a missed note heals on the next pass.
type CallLogService struct {
	st   Store
	dms  *DMService
	sink atomic.Pointer[CallLogSink]

	// now is the clock; the durations below default to the package constants.
	now      func() time.Time
	coalesce time.Duration
	tick     time.Duration
	grace    time.Duration

	// callLogMu guards the fields below. It is a leaf lock: nothing is read,
	// written or called while it is held except these maps. Callers may hold
	// voiceLock(userID) (ws) when they post a note, so the order is
	// voiceLock -> callLogMu and never the reverse.
	callLogMu syncutil.Mutex
	// running is true between StartCallLogWorker and stop. A note posted while
	// it is false does nothing (unit tests, boot before the worker starts).
	running    bool
	dirty      map[int64]*callLogPending
	emptySince map[int64]time.Time
	suppressed map[int64]struct{}

	wake     chan struct{}
	done     chan struct{}
	stop     chan struct{}
	stopOnce sync.Once
}

// NewCallLogService creates a CallLogService. dms may be nil, in which case a
// created row reopens no closed DM.
func NewCallLogService(st Store, dms *DMService) *CallLogService {
	return &CallLogService{
		st: st, dms: dms,
		now:      func() time.Time { return time.Now().UTC() },
		coalesce: callLogCoalesce, tick: callLogTick, grace: callEndGrace,
		dirty:      make(map[int64]*callLogPending),
		emptySince: make(map[int64]time.Time),
		suppressed: make(map[int64]struct{}),
		wake:       make(chan struct{}, 1),
	}
}

// SetSink installs the sink that delivers created and ended rows. Called
// before the worker starts.
func (s *CallLogService) SetSink(sink CallLogSink) {
	if s == nil {
		return
	}
	s.sink.Store(&sink)
}

func (s *CallLogService) loadSink() CallLogSink {
	if p := s.sink.Load(); p != nil {
		return *p
	}
	return nil
}

// NoteJoin records that userID completed a voice join into channelID at the
// given time. It never blocks and does no I/O. The channel type is decided by
// the worker, which drops anything that is not a DM.
func (s *CallLogService) NoteJoin(channelID, userID int64, at time.Time) {
	if s == nil {
		return
	}
	s.callLogMu.Lock()
	if !s.running {
		s.callLogMu.Unlock()
		return
	}
	p := s.pendingLocked(channelID)
	if prev, ok := p.joiners[userID]; !ok || at.Before(prev) {
		p.joiners[userID] = at
	}
	s.callLogMu.Unlock()
	s.signal()
}

// NoteLeave records that a voice row in channelID was deleted at the given
// time. Same contract as NoteJoin.
func (s *CallLogService) NoteLeave(channelID int64, at time.Time) {
	if s == nil {
		return
	}
	s.callLogMu.Lock()
	if !s.running {
		s.callLogMu.Unlock()
		return
	}
	p := s.pendingLocked(channelID)
	if at.After(p.lastLeave) {
		p.lastLeave = at
	}
	s.callLogMu.Unlock()
	s.signal()
}

// pendingLocked returns the channel's pending entry, creating it. Caller
// holds callLogMu.
func (s *CallLogService) pendingLocked(channelID int64) *callLogPending {
	p := s.dirty[channelID]
	if p == nil {
		p = &callLogPending{joiners: make(map[int64]time.Time)}
		s.dirty[channelID] = p
	}
	return p
}

// signal wakes the worker without ever blocking the caller.
func (s *CallLogService) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// takeDirty swaps out the dirty map.
func (s *CallLogService) takeDirty() map[int64]*callLogPending {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	out := s.dirty
	s.dirty = make(map[int64]*callLogPending)
	return out
}

// requeue puts a failed reconcile's notes back so the next pass retries them.
func (s *CallLogService) requeue(channelID int64, p *callLogPending) {
	if p == nil {
		return
	}
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	cur := s.pendingLocked(channelID)
	for uid, at := range p.joiners {
		if prev, ok := cur.joiners[uid]; !ok || at.Before(prev) {
			cur.joiners[uid] = at
		}
	}
	if p.lastLeave.After(cur.lastLeave) {
		cur.lastLeave = p.lastLeave
	}
}

// dropState forgets everything held for a channel.
func (s *CallLogService) dropState(channelID int64) {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	delete(s.dirty, channelID)
	delete(s.emptySince, channelID)
	delete(s.suppressed, channelID)
}

func (s *CallLogService) isSuppressed(channelID int64) bool {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	_, ok := s.suppressed[channelID]
	return ok
}

func (s *CallLogService) setSuppressed(channelID int64, on bool) {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	if on {
		s.suppressed[channelID] = struct{}{}
		return
	}
	delete(s.suppressed, channelID)
}

func (s *CallLogService) getEmptySince(channelID int64) (time.Time, bool) {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	t, ok := s.emptySince[channelID]
	return t, ok
}

func (s *CallLogService) setEmptySince(channelID int64, at time.Time) {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	s.emptySince[channelID] = at
}

func (s *CallLogService) clearEmptySince(channelID int64) {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	delete(s.emptySince, channelID)
}

// nextGraceDeadline is the earliest moment a call whose room is empty may
// end, or the zero time when no room is waiting out the grace period.
func (s *CallLogService) nextGraceDeadline() time.Time {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	var next time.Time
	for _, since := range s.emptySince {
		if d := since.Add(s.grace); next.IsZero() || d.Before(next) {
			next = d
		}
	}
	return next
}

// graceDue lists the channels whose grace period has run out at now.
func (s *CallLogService) graceDue(now time.Time) []int64 {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	var due []int64
	for ch, since := range s.emptySince {
		if !now.Before(since.Add(s.grace)) {
			due = append(due, ch)
		}
	}
	slices.Sort(due)
	return due
}

// callLiveContent is the text only old clients show for a live call row.
const callLiveContent = "started a call."

// callEndedContent is the fallback text of an ended call.
func callEndedContent(d time.Duration) string {
	if d < time.Minute {
		return "started a call that lasted a few seconds."
	}
	mins := int(d / time.Minute)
	if mins == 1 {
		return "started a call that lasted 1 minute."
	}
	return fmt.Sprintf("started a call that lasted %d minutes.", mins)
}

func formatCallTime(t time.Time) string { return t.UTC().Format(sqliteDateTimeLayout) }

func parseCallTime(s string) (time.Time, bool) {
	t, err := time.Parse(sqliteDateTimeLayout, s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// voiceJoinTime reads the instant a voice row was created from its join token
// (db.newVoiceJoinToken: an RFC 3339 nanosecond instant, then a sequence).
func voiceJoinTime(token string) (time.Time, bool) {
	const instantLen = len("2006-01-02T15:04:05.000000000Z")
	if len(token) < instantLen {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, token[:instantLen])
	if err != nil {
		return time.Time{}, false
	}
	return t.UTC(), true
}
