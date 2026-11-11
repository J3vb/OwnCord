package service

import (
	"context"
	"fmt"
	"slices"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// Call log worker timing: a call ends callEndGrace after its room empties (a quick rejoin
// is the same call); notes coalesce for callLogCoalesce; callLogTick heals missed notes.
const (
	callLogCoalesce = 2 * time.Second
	callLogTick     = 60 * time.Second
	callEndGrace    = 10 * time.Second
)

// CallLogStore is the data access the call log worker needs beyond Store's reads.
type CallLogStore interface {
	CreateCallLog(ctx context.Context, p db.CallLogParams) (*db.CallLogRow, error)
	EndCall(ctx context.Context, messageID int64, endedAt, content string) (bool, error)
	ListOpenCalls(ctx context.Context) ([]db.OpenCall, error)
	GetOpenCall(ctx context.Context, channelID int64) (*db.OpenCall, error)
	AddCallParticipants(ctx context.Context, messageID int64, userIDs []int64) error
	TouchCall(ctx context.Context, messageID int64, seenAt string) error
	GetCallInfo(ctx context.Context, messageID int64) (*db.CallInfo, error)
}

// CallLogEvent is what the sink needs to build the frames for one call log row. Author
// and AuthorRole are set only on a created row; Audience is who the DM frame goes to.
type CallLogEvent struct {
	MessageID  int64
	ChannelID  int64
	Author     *db.User
	AuthorRole string
	Content    string
	Timestamp  string
	Call       db.CallInfo
	Audience   []int64
	Reopens    []RingReopen
}

// CallLogSink delivers a call log row to connected clients (the hub). The worker holds no lock while calling
// it.
type CallLogSink interface {
	CallLogCreated(ctx context.Context, ev CallLogEvent)
	CallLogEnded(ctx context.Context, ev CallLogEvent)
}

type callLogPending struct {
	joiners   map[int64]time.Time
	lastLeave time.Time
}

type callLogServiceStore interface {
	CallLogStore
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	GetChannelVoiceStates(ctx context.Context, channelID int64) ([]db.VoiceState, error)
	GetDMDeliveryTargets(ctx context.Context, channelID, senderID int64) (isGroup bool, targets []db.DMDeliveryTarget, err error)
	IsTrustedSender(ctx context.Context, recipientID, senderID int64) (bool, error)
}

// CallLogService derives one message row per DM call from voice presence. Joins and leaves
// only post notes; one worker goroutine owns every write and reconciles voice_states with
// the live call row, so a missed note heals on the next pass.
type CallLogService struct {
	st   callLogServiceStore
	dms  *DMService
	sink atomic.Pointer[CallLogSink]

	now      func() time.Time
	coalesce time.Duration
	tick     time.Duration
	grace    time.Duration

	// callLogMu guards the fields below. Leaf lock: only these maps are touched under it.
	// Callers may hold voiceLock(userID) (ws) when posting a note, so the order is
	// voiceLock -> callLogMu, never the reverse.
	callLogMu syncutil.Mutex
	// running is true between StartCallLogWorker and stop; a note posted while false does nothing.
	running    bool
	dirty      map[int64]*callLogPending
	emptySince map[int64]time.Time
	suppressed map[int64]struct{}
	// retryAt/retryDelay back a channel off after a failed reconcile. recorded holds the
	// participants already written for a live call (by message id) so an unchanged room costs
	// no write; audiences holds where a call's start went so its end reaches the same people.
	retryAt    map[int64]time.Time
	retryDelay map[int64]time.Duration
	recorded   map[int64]map[int64]struct{}
	audiences  map[int64][]int64

	wake chan struct{}
	done chan struct{}
}

// NewCallLogService creates a CallLogService. dms may be nil: a created row then reopens no closed DM.
func NewCallLogService(st callLogServiceStore, dms *DMService) *CallLogService {
	return &CallLogService{
		st: st, dms: dms,
		now:      func() time.Time { return time.Now().UTC() },
		coalesce: callLogCoalesce, tick: callLogTick, grace: callEndGrace,
		dirty:      make(map[int64]*callLogPending),
		emptySince: make(map[int64]time.Time),
		suppressed: make(map[int64]struct{}),
		retryAt:    make(map[int64]time.Time),
		retryDelay: make(map[int64]time.Duration),
		recorded:   make(map[int64]map[int64]struct{}),
		audiences:  make(map[int64][]int64),
		wake:       make(chan struct{}, 1),
	}
}

// SetSink installs the sink for created and ended rows; call before the worker starts.
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

// NoteJoin records that userID completed a voice join into channelID at the given time.
// Never blocks, no I/O; the worker drops anything not a DM.
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

// NoteLeave records that a voice row in channelID was deleted at the given time.
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

// pendingLocked returns the channel's pending entry, creating it. Caller holds callLogMu.
func (s *CallLogService) pendingLocked(channelID int64) *callLogPending {
	p := s.dirty[channelID]
	if p == nil {
		p = &callLogPending{joiners: make(map[int64]time.Time)}
		s.dirty[channelID] = p
	}
	return p
}

func (s *CallLogService) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *CallLogService) takeDirty() map[int64]*callLogPending {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	out := s.dirty
	s.dirty = make(map[int64]*callLogPending)
	return out
}

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

func (s *CallLogService) dropState(channelID int64) {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	delete(s.dirty, channelID)
	delete(s.emptySince, channelID)
	delete(s.suppressed, channelID)
	delete(s.retryAt, channelID)
	delete(s.retryDelay, channelID)
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

// nextDue is the earliest moment the worker has timed work (a room's grace period or a
// retry delay running out); zero when none.
func (s *CallLogService) nextDue() time.Time {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	var next time.Time
	consider := func(t time.Time) {
		if next.IsZero() || t.Before(next) {
			next = t
		}
	}
	for ch, since := range s.emptySince {
		d := since.Add(s.grace)
		if r, ok := s.retryAt[ch]; ok && r.After(d) {
			d = r
		}
		consider(d)
	}
	for _, r := range s.retryAt {
		consider(r)
	}
	return next
}

func (s *CallLogService) dueChannels(now time.Time) []int64 {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	set := make(map[int64]struct{})
	for ch, since := range s.emptySince {
		d := since.Add(s.grace)
		if r, ok := s.retryAt[ch]; ok && r.After(d) {
			d = r
		}
		if !now.Before(d) {
			set[ch] = struct{}{}
		}
	}
	for ch, r := range s.retryAt {
		if !now.Before(r) {
			set[ch] = struct{}{}
		}
	}
	due := make([]int64, 0, len(set))
	for ch := range set {
		due = append(due, ch)
	}
	slices.Sort(due)
	return due
}

func (s *CallLogService) pendingLeave(channelID int64) time.Time {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	if p := s.dirty[channelID]; p != nil {
		return p.lastLeave
	}
	return time.Time{}
}

func (s *CallLogService) takeDirtyFor(channelID int64) *callLogPending {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	p := s.dirty[channelID]
	delete(s.dirty, channelID)
	return p
}

func (s *CallLogService) inBackoff(channelID int64) bool {
	now := s.now()
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	r, ok := s.retryAt[channelID]
	return ok && now.Before(r)
}

func (s *CallLogService) noteFailure(channelID int64) {
	now := s.now()
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	d := s.retryDelay[channelID] * 2
	d = max(d, s.coalesce)
	d = min(d, max(s.tick, s.coalesce))
	s.retryDelay[channelID] = d
	s.retryAt[channelID] = now.Add(d)
}

func (s *CallLogService) clearRetry(channelID int64) {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	delete(s.retryAt, channelID)
	delete(s.retryDelay, channelID)
}

func (s *CallLogService) recordedSet(messageID int64) map[int64]struct{} {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	out := make(map[int64]struct{}, len(s.recorded[messageID]))
	for uid := range s.recorded[messageID] {
		out[uid] = struct{}{}
	}
	return out
}

func (s *CallLogService) markRecorded(messageID int64, userIDs []int64) {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	set := s.recorded[messageID]
	if set == nil {
		set = make(map[int64]struct{}, len(userIDs))
		s.recorded[messageID] = set
	}
	for _, uid := range userIDs {
		set[uid] = struct{}{}
	}
}

func (s *CallLogService) setAudience(messageID int64, audience []int64) {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	s.audiences[messageID] = slices.Clone(audience)
}

func (s *CallLogService) forgetCall(messageID int64) []int64 {
	s.callLogMu.Lock()
	defer s.callLogMu.Unlock()
	aud := s.audiences[messageID]
	delete(s.audiences, messageID)
	delete(s.recorded, messageID)
	return aud
}

// callLiveContent is the text only old clients show for a live call row.
const callLiveContent = "started a call."

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

func formatCallTime(t time.Time) string { return t.UTC().Format(dbtime.SQLiteLayout) }

func parseCallTime(s string) (time.Time, bool) {
	t, err := time.Parse(dbtime.SQLiteLayout, s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}
