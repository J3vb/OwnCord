package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// PollStore is the slice of the database the poll commands use beyond Store: a poll's own
// row, its block as a viewer sees it, and the vote and end writes. Declared here so Store,
// whose size is pinned, does not grow.
type PollStore interface {
	GetPollMeta(ctx context.Context, messageID int64) (*db.PollMeta, error)
	GetPollInfo(ctx context.Context, messageID, viewerID int64) (*db.PollInfo, error)
	SetPollVote(ctx context.Context, messageID, userID int64, answerIDs []int64) (*db.PollVoteResult, error)
	EndPoll(ctx context.Context, messageID int64) (*db.PollEndResult, error)
}

var _ PollStore = (*db.DB)(nil)

// PollInfo is the poll block a chat_message frame carries.
type PollInfo = db.PollInfo

// PollCount is one answer's vote count in a poll_update.
type PollCount = db.PollCount

// pollDeps is what the poll commands need beyond Store: store (nil disables polls) and
// wake, which tells the expirer a poll was created so it re-reads its next deadline.
type pollDeps struct {
	store PollStore
	wake  func()
}

// SetPollWake installs the callback a committed poll calls so the expirer re-reads its
// deadline. Call once at startup, before the service is shared.
func (s *MessageService) SetPollWake(wake func()) { s.poll.wake = wake }

const (
	maxPollQuestionRunes = 300
	minPollAnswers       = 2
	maxPollAnswers       = 10
	maxPollAnswerRunes   = 55
)

// pollCreateLimit/pollCreateWindow cap polls per user on top of the send rate gate: a poll
// is a long-lived object with a timer row.
const (
	pollCreateLimit  = 5
	pollCreateWindow = 10 * time.Minute
)

var pollDurationsHours = []int{1, 4, 8, 24, 72, 168}

// PollAnswerParam is one answer of a poll being created.
type PollAnswerParam struct {
	Text  string
	Emoji string
}

// PollCreateParams is one poll_create: a poll message by UserID in ChannelID.
type PollCreateParams struct {
	// ClientMessageID is required: polls exist only for clients that retry by receipt, so a lost acknowledgement
	// never posts a second poll.
	ClientMessageID  string
	ChannelID        int64
	UserID           int64
	Username         string
	Question         string
	Answers          []PollAnswerParam
	DurationHours    int
	AllowMultiselect bool
}

func (p PollCreateParams) fingerprint() (string, error) {
	b, err := json.Marshal(struct {
		Question         string
		Answers          []PollAnswerParam
		DurationHours    int
		AllowMultiselect bool
	}{p.Question, p.Answers, p.DurationHours, p.AllowMultiselect})
	if err != nil {
		return "", fmt.Errorf("%w: fingerprint poll: %w", ErrInternal, err)
	}
	return string(b), nil
}

// CreatePoll posts a poll as an ordinary message by the caller: its content is a readable
// fallback of the question and answers, and the poll rows commit with the message and its
// receipt. Creating is sending, so the send gates apply unchanged. A poll never pings; no
// channel push. Callers emit events from the result.
// Order: rate gate and receipt lookup, poll limiter, validation, send gates, slow mode,
// then commit.
func (s *MessageService) CreatePoll(ctx context.Context, p PollCreateParams) (*SendMessageResult, error) {
	ctx, done := traceCall(ctx, "service/message", "MessageService.CreatePoll",
		telemetry.Int64("user_id", p.UserID),
		telemetry.Int64("channel_id", p.ChannelID),
	)
	defer done()

	if s.poll.store == nil {
		return nil, fmt.Errorf("%w: polls are not available", ErrInternal)
	}
	if p.ClientMessageID == "" {
		return nil, fmt.Errorf("%w: client_message_id is required", ErrBadRequest)
	}
	fp, err := p.fingerprint()
	if err != nil {
		return nil, err
	}
	sp := SendMessageParams{
		ClientMessageID: p.ClientMessageID, ChannelID: p.ChannelID,
		UserID: p.UserID, Username: p.Username, Poll: fp,
	}
	delivery, retry, err := s.answerSendRetry(ctx, sp)
	if err != nil || retry != nil {
		return retry, err
	}
	if s.limiter != nil && !s.limiter.Allow(auth.Key("poll_create", p.UserID), pollCreateLimit, pollCreateWindow) {
		return nil, ErrRateLimited
	}
	input, content, err := validatePoll(p)
	if err != nil {
		return nil, err
	}
	ch, err := lookupChannel(ctx, s.st, p.ChannelID)
	if err != nil {
		return nil, err
	}
	if err := s.checkSendPermission(ctx, p.UserID, ch); err != nil {
		return nil, err
	}
	refundSlow, err := s.checkMessageSlowMode(ctx, sp, ch)
	if err != nil {
		return nil, err
	}
	delivery.Content, delivery.Poll = content, input
	// No mention set: a poll never pings, whatever @names its text holds.
	msg, _, _, duplicate, err := s.persistMessage(ctx, sp, content, mentionSet{}, delivery)
	if err != nil {
		refundSlow()
		return nil, err
	}
	if duplicate {
		refundSlow()
		return &SendMessageResult{MessageID: msg.ID, Timestamp: msg.Timestamp, Duplicate: true}, nil
	}
	if s.poll.wake != nil {
		s.poll.wake()
	}
	return s.pollResult(ctx, sp, msg, content, ch), nil
}

// pollResult builds the SendMessageResult of a committed poll and runs its post-commit
// work: the poll block read-back, DM side effects (an untrusted 1:1 recipient gets a
// staged request instead of delivery) and, for a DM only, push. No mention badge or channel push.
func (s *MessageService) pollResult(ctx context.Context, sp SendMessageParams, msg *db.Message, content string, ch *db.Channel) *SendMessageResult {
	isDM := ch.Type == "dm"
	result := &SendMessageResult{
		MessageID: msg.ID, Timestamp: msg.Timestamp, Content: content,
		IsDM: isDM, Channel: ch, Mentions: []int64{}, ThreadJoined: msg.ThreadJoined,
	}
	// The write is committed; a failed read-back only costs the live block.
	readCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), pollReadBackTimeout)
	info, err := s.poll.store.GetPollInfo(readCtx, msg.ID, 0)
	cancel()
	if err == nil && info == nil {
		err = errors.New("no poll row")
	}
	if err != nil || info == nil {
		slog.Error("poll create: read poll block failed", "err", err, "msg_id", msg.ID)
	}
	result.Poll = info
	if !isDM {
		return result
	}
	if !s.sendMessageDMSideEffects(ctx, sp, result) {
		return result
	}
	s.pushDMParticipants(ctx, sp, result)
	slog.Debug("poll created", "user", sp.Username, "channel_id", sp.ChannelID, "msg_id", msg.ID)
	return result
}

func (s *MessageService) pushDMParticipants(ctx context.Context, sp SendMessageParams, result *SendMessageResult) {
	if s.pushNotifier == nil {
		return
	}
	bgCtx, channelID, authorID, participants := context.WithoutCancel(ctx), sp.ChannelID, sp.UserID, result.ParticipantIDs
	s.runBackground(bgCtx, "push dispatch", func(ctx context.Context) {
		ctx, cancel := context.WithTimeout(ctx, backgroundJobTimeout)
		defer cancel()
		s.pushNotifier.Notify(ctx, channelID, authorID, participants)
	})
}

func validatePoll(p PollCreateParams) (*db.PollInput, string, error) {
	if !slices.Contains(pollDurationsHours, p.DurationHours) {
		return nil, "", fmt.Errorf("%w: duration_hours must be one of %v", ErrBadRequest, pollDurationsHours)
	}
	if n := len(p.Answers); n < minPollAnswers || n > maxPollAnswers {
		return nil, "", fmt.Errorf("%w: a poll needs %d to %d answers", ErrBadRequest, minPollAnswers, maxPollAnswers)
	}
	question, err := pollText(p.Question, "question", maxPollQuestionRunes)
	if err != nil {
		return nil, "", err
	}
	in := &db.PollInput{
		Question: question, DurationHours: p.DurationHours, AllowMultiselect: p.AllowMultiselect,
		Answers: make([]db.PollAnswerInput, 0, len(p.Answers)),
	}
	var fallback strings.Builder
	fallback.WriteString("📊 " + question)
	for i := range p.Answers {
		text, err := pollText(p.Answers[i].Text, "answer", maxPollAnswerRunes)
		if err != nil {
			return nil, "", err
		}
		a := db.PollAnswerInput{Text: text}
		fallback.WriteString("\n- ")
		if e := p.Answers[i].Emoji; e != "" {
			if err := validateEmoji(e); err != nil {
				return nil, "", err
			}
			if strings.IndexFunc(e, pollBreakRune) >= 0 {
				return nil, "", fmt.Errorf("%w: poll emoji contains control characters", ErrBadRequest)
			}
			a.Emoji = &e
			fallback.WriteString(e + " ")
		}
		fallback.WriteString(text)
		in.Answers = append(in.Answers, a)
	}
	return in, fallback.String(), nil
}

// pollReadBackTimeout bounds the post-commit read of the new poll's block. The handler
// runs on the connection's read pump, so a stalled read must not hold it long.
const pollReadBackTimeout = 2 * time.Second

func pollBreakRune(r rune) bool {
	return unicode.IsControl(r) || unicode.In(r, unicode.Zl, unicode.Zp)
}

func pollText(raw, field string, maxRunes int) (string, error) {
	if len(raw) > maxRunes*4 {
		return "", fmt.Errorf("%w: poll %s exceeds %d characters", ErrBadRequest, field, maxRunes)
	}
	clean := sanitizeToFixpoint(raw)
	if strings.IndexFunc(clean, pollBreakRune) >= 0 {
		return "", fmt.Errorf("%w: poll %s contains control characters", ErrBadRequest, field)
	}
	text := strings.TrimSpace(clean)
	if text == "" {
		return "", fmt.Errorf("%w: poll %s cannot be empty", ErrBadRequest, field)
	}
	if utf8.RuneCountInString(text) > maxRunes {
		return "", fmt.Errorf("%w: poll %s exceeds %d characters", ErrBadRequest, field, maxRunes)
	}
	return text, nil
}
