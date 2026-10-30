package discordimport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// ErrImportRunning is returned by Start while another import is running. One
// import runs at a time, server-wide.
var ErrImportRunning = db.ErrImportRunning

// ErrNothingToImport means the export held no message the import takes.
var ErrNothingToImport = errors.New("the export holds no messages to import")

// DefaultChunkSize is how many messages go into one writer transaction.
const DefaultChunkSize = 500

const (
	maxChannelNameRunes = 100
	maxTopicRunes       = 1024
	maxAuthorNameRunes  = 64
	maxFilenameBytes    = 255
	maxErrorRunes       = 300
	finishTimeout       = 30 * time.Second
)

// Store is the database surface the import needs. *db.DB satisfies it.
type Store interface {
	EnsureImportAccount(ctx context.Context) (int64, error)
	StartImport(ctx context.Context, p db.StartImportParams) (channelID, jobID int64, err error)
	ImportChunk(ctx context.Context, p db.ImportChunkParams) (map[string]int64, error)
	PublishImport(ctx context.Context, jobID, channelID, lastMessageID int64, pr db.ImportProgress) error
	AbandonImport(ctx context.Context, jobID, channelID int64, status, reason string, pr db.ImportProgress) error
	CreateAttachment(ctx context.Context, id string, uploaderID int64, filename, storedAs, mimeType string, size int64, width, height *int) error
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
}

// Files is the storage the media is copied into. SaveReserved is the one write
// path every stored byte goes through: it takes a reservation, refuses
// executables by content, enforces the size limit and lands the reservation.
// api.ReservedStore is the production implementation.
type Files interface {
	SaveReserved(ctx context.Context, res *service.StorageReservation, name string, r io.Reader) (int64, error)
	Delete(name string) error
}

// Uploads supplies the rules a normal upload follows: the owner's file-type
// policy, the per-file cap and the free-space floor. *service.UploadService
// satisfies it. The per-user quota does not apply: the hidden account is not a
// person with a quota.
type Uploads interface {
	FileTypePolicy(ctx context.Context) (storage.FileTypePolicy, error)
	ReserveHeadroom(ctx context.Context, n int64) (*service.StorageReservation, error)
	MaxUploadBytes() int64
}

// Announcer is told once when the finished channel becomes visible. The
// composition root sends the same channel-created event the admin channel
// create sends. No other event is ever sent for an import.
type Announcer interface {
	ChannelCreated(ctx context.Context, ch *db.Channel)
}

// Config wires a Runner.
type Config struct {
	Store     Store
	Files     Files
	Uploads   Uploads
	Announcer Announcer
	// Group runs the import in the background so the lifecycle owner can join
	// it before the database closes. Nil runs it unowned, as in tests.
	Group *syncutil.Group
	// ChunkSize is messages per transaction; DefaultChunkSize when zero.
	ChunkSize int
	// ChunkBytes and ChunkAge write a chunk early once the files copied for it
	// pass that many bytes or have been waiting that long. Those files are
	// unlinked attachment rows until the chunk commits, and the orphan sweep
	// reclaims unlinked rows after an hour. Zero takes the defaults.
	ChunkBytes int64
	ChunkAge   time.Duration
}

// Defaults for Config.ChunkBytes and Config.ChunkAge.
const (
	DefaultChunkBytes = 64 << 20
	DefaultChunkAge   = 10 * time.Minute
)

// abandon attempts: the clean-up of a dead import is retried this often, with a
// doubling wait, before the job is left for the next start to take over.
const abandonAttempts = 4

// Runner runs imports. Only one import can run at a time, server-wide: the
// database refuses a second running job, whichever Runner starts it.
type Runner struct {
	cfg Config

	// afterChunk, when set by a test, runs after each committed chunk.
	afterChunk func(ctx context.Context, chunk int)
	// retryDelay is the first wait between clean-up attempts.
	retryDelay time.Duration
}

// NewRunner returns a Runner.
func NewRunner(cfg Config) *Runner {
	if cfg.ChunkSize <= 0 {
		cfg.ChunkSize = DefaultChunkSize
	}
	if cfg.ChunkBytes == 0 {
		cfg.ChunkBytes = DefaultChunkBytes
	}
	if cfg.ChunkAge == 0 {
		cfg.ChunkAge = DefaultChunkAge
	}
	return &Runner{cfg: cfg, retryDelay: 500 * time.Millisecond}
}

// Request is one import.
type Request struct {
	// Export is opened by the caller, who closes it after Wait returns.
	Export Export
	// CategoryID is the category the new channel goes in, 0 for none.
	CategoryID int64
	// CreatedBy is the admin starting the import.
	CreatedBy  int64
	SourceName string
}

// Result is how a job ended.
type Result struct {
	Status             string
	Imported           int64
	Skipped            int64
	SkippedAttachments int64
	Err                error
}

// Job is a started import.
type Job struct {
	ID        int64
	ChannelID int64

	cancel context.CancelFunc
	done   chan struct{}
	result Result
}

// Cancel asks the import to stop. It deletes the channel and ends the job as
// cancelled; messages already inserted go with the channel.
func (j *Job) Cancel() { j.cancel() }

// Wait blocks until the job has ended and returns how.
func (j *Job) Wait() Result {
	<-j.done
	return j.result
}

// ErrShuttingDown is returned by Start once the server is draining.
var ErrShuttingDown = errors.New("the server is shutting down")

// Start reads the export's header, creates the hidden channel and its job, and
// runs the import in the background. The job outlives ctx (a request context
// ends when the response is written); it ends when it finishes, when Cancel is
// called, or when the Group is stopped. It returns ErrImportRunning when
// another import is running.
func (r *Runner) Start(ctx context.Context, req Request) (*Job, error) {
	header, err := readHeader(ctx, req.Export)
	if err != nil {
		return nil, err
	}
	account, err := r.cfg.Store.EnsureImportAccount(ctx)
	if err != nil {
		return nil, fmt.Errorf("import account: %w", err)
	}
	live.startMu.Lock()
	channelID, jobID, err := r.cfg.Store.StartImport(ctx, db.StartImportParams{
		AdoptStale:       true,
		LiveJobIDs:       liveJobIDs(),
		Name:             cleanText(header.Channel.Name, maxChannelNameRunes, "imported-channel"),
		Topic:            cleanText(header.Channel.Topic, maxTopicRunes, ""),
		CategoryID:       req.CategoryID,
		CreatedBy:        req.CreatedBy,
		SourceName:       cleanText(req.SourceName, maxChannelNameRunes, ""),
		DiscordChannelID: header.Channel.ID,
	})
	if err == nil {
		setLive(jobID, true)
	}
	live.startMu.Unlock()
	if err != nil {
		return nil, err
	}

	// stopCtx ends when Cancel is called; the group's own context ends the job
	// at shutdown.
	stopCtx, stop := context.WithCancel(context.WithoutCancel(ctx))
	job := &Job{ID: jobID, ChannelID: channelID, cancel: stop, done: make(chan struct{})}
	admitted := r.cfg.Group.Go(ctx, func(groupCtx context.Context) {
		defer close(job.done)
		defer setLive(jobID, false)
		defer stop()
		runCtx, cancel := context.WithCancel(groupCtx)
		defer cancel()
		defer context.AfterFunc(stopCtx, cancel)()
		job.result = r.run(runCtx, stopCtx, req.Export, account, channelID, jobID, header.Channel.ID)
	})
	if !admitted {
		stop()
		setLive(jobID, false)
		halted := make(chan struct{})
		close(halted)
		r.abandon(context.WithoutCancel(ctx), halted, jobID, channelID, db.ImportFailed, ErrShuttingDown.Error(), db.ImportProgress{})
		return nil, ErrShuttingDown
	}
	return job, nil
}

var errHeaderDone = errors.New("header read")

func readHeader(ctx context.Context, ex Export) (Header, error) {
	rc, err := ex.OpenJSON()
	if err != nil {
		return Header{}, fmt.Errorf("opening the export: %w", err)
	}
	defer rc.Close() //nolint:errcheck
	var h Header
	_, err = Decode(ctx, rc, Visitor{Header: func(got Header) error { h = got; return errHeaderDone }})
	if err != nil && !errors.Is(err, errHeaderDone) {
		return Header{}, err
	}
	return h, nil
}

// cleanText sanitizes like any other free text, trims it and cuts it to max
// runes. An empty result becomes fallback.
func cleanText(s string, maxRunes int, fallback string) string {
	s = strings.TrimSpace(service.SanitizeText(s))
	if r := []rune(s); len(r) > maxRunes {
		s = strings.TrimSpace(string(r[:maxRunes]))
	}
	if s == "" {
		return fallback
	}
	return s
}

// runState is one job's working set.
type runState struct {
	// stop ends when Cancel is called. Cancel reaches ctx through a callback, so
	// the steps that must not slip past it (a chunk, the publish) also read this
	// directly.
	stop                      context.Context
	account, channelID, jobID int64
	// discordChannel is the export's channel id: a reply only links when it
	// points into this channel.
	discordChannel string
	ids            map[string]int64
	chunk          []db.ImportMessage
	chunks         int
	lastID         int64
	prog           db.ImportProgress
	// chunkBytes is the size of the files copied for the open chunk, and
	// chunkSince when the first of them landed.
	chunkBytes int64
	chunkSince time.Time
	policy     storage.FileTypePolicy
	maxFile    int64
}

func (r *Runner) run(ctx, stop context.Context, ex Export, account, channelID, jobID int64, discordChannel string) Result {
	st := &runState{stop: stop, account: account, channelID: channelID, jobID: jobID, discordChannel: discordChannel, ids: map[string]int64{}}
	err := r.execute(ctx, ex, st)
	if err == nil {
		return Result{Status: db.ImportDone, Imported: st.prog.Imported, Skipped: st.prog.Skipped, SkippedAttachments: st.prog.SkippedAttachments}
	}
	status, reason := db.ImportFailed, cleanText(err.Error(), maxErrorRunes, "import failed")
	switch {
	case st.stop.Err() != nil:
		// An administrator asked for this.
		status, reason = db.ImportCancelled, "cancelled"
	case errors.Is(err, context.Canceled):
		// Nobody asked: the server is stopping.
		reason = ErrServerStopped.Error()
	}
	// The channel is removed even when ctx is what ended the job. A server
	// shutdown (ctx done, no administrator stop) cuts the clean-up retries short.
	var halt <-chan struct{}
	if st.stop.Err() == nil {
		halt = ctx.Done()
	}
	r.abandon(context.WithoutCancel(ctx), halt, jobID, channelID, status, reason, st.prog)
	if status == db.ImportFailed {
		slog.Warn("discord import failed", "job_id", jobID, "error", err)
	}
	return Result{Status: status, Imported: st.prog.Imported, Skipped: st.prog.Skipped, SkippedAttachments: st.prog.SkippedAttachments, Err: err}
}

func (r *Runner) execute(ctx context.Context, ex Export, st *runState) error {
	var err error
	if st.policy, err = r.cfg.Uploads.FileTypePolicy(ctx); err != nil {
		return fmt.Errorf("reading the file-type policy: %w", err)
	}
	st.maxFile = r.cfg.Uploads.MaxUploadBytes()

	rc, err := ex.OpenJSON()
	if err != nil {
		return fmt.Errorf("opening the export: %w", err)
	}
	defer rc.Close() //nolint:errcheck

	sum, err := Decode(ctx, rc, Visitor{Message: func(m Message) error { return r.addMessage(ctx, ex, st, &m) }})
	if err != nil {
		return err
	}
	if err := r.flush(ctx, st); err != nil {
		return err
	}
	if st.prog.Imported == 0 {
		return ErrNothingToImport
	}
	st.prog.Total = int64(max(sum.MessageCount, sum.Seen))
	if err := st.interrupted(ctx); err != nil {
		return err
	}
	if err := r.cfg.Store.PublishImport(ctx, st.jobID, st.channelID, st.lastID, st.prog); err != nil {
		return err
	}
	r.announce(ctx, st.channelID)
	return nil
}

// announce sends the one channel-created event. The import is already
// committed, so a cancelled ctx must not swallow it.
func (r *Runner) announce(ctx context.Context, channelID int64) {
	if r.cfg.Announcer == nil {
		return
	}
	tail := context.WithoutCancel(ctx)
	ch, err := r.cfg.Store.GetChannel(tail, channelID)
	if err != nil || ch == nil {
		slog.Error("discord import: reading the finished channel failed", "channel_id", channelID, "error", err)
		return
	}
	r.cfg.Announcer.ChannelCreated(tail, ch)
}

// parseTime reads an export timestamp as a UTC instant.
func parseTime(s string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, s)
	return t.UTC(), err == nil
}

var colorRe = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

// addMessage turns one exported message into a chunk entry, or counts it as
// skipped.
func (r *Runner) addMessage(ctx context.Context, ex Export, st *runState, m *Message) error {
	if !m.Importable() {
		st.prog.Skipped++
		return nil
	}
	ts, ok := parseTime(m.Timestamp)
	if !ok {
		st.prog.Skipped++
		return nil
	}
	im := db.ImportMessage{
		Key:           m.ID,
		Content:       service.SanitizeImportedContent(m.Content),
		Timestamp:     ts.UTC(),
		Pinned:        m.IsPinned,
		DiscordUserID: cleanText(m.Author.ID, 32, "0"),
		AuthorName:    cleanText(m.Author.DisplayName(), maxAuthorNameRunes, "Unknown"),
	}
	if colorRe.MatchString(m.Author.Color) {
		im.AuthorColor = m.Author.Color
	}
	if m.TimestampEdited != nil {
		if et, ok := parseTime(*m.TimestampEdited); ok {
			im.EditedAt = et
		}
	}
	if ref := m.Reference; ref != nil && ref.MessageID != "" && (ref.ChannelID == "" || ref.ChannelID == st.discordChannel) {
		im.ReplyKey = ref.MessageID
	}
	for i := range m.Attachments {
		id, err := r.copyAttachment(ctx, ex, st, &m.Attachments[i])
		if err != nil {
			return err
		}
		if id == "" {
			st.prog.SkippedAttachments++
			continue
		}
		im.AttachmentIDs = append(im.AttachmentIDs, id)
	}
	if im.Content == "" && len(im.AttachmentIDs) == 0 {
		st.prog.Skipped++
		return nil
	}
	st.chunk = append(st.chunk, im)
	if len(st.chunk) >= r.cfg.ChunkSize || r.chunkOverdue(st) {
		return r.flush(ctx, st)
	}
	return nil
}

// interrupted reports why the import must stop, or nil to go on.
func (st *runState) interrupted(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("import stopped: %w", err)
	}
	if err := st.stop.Err(); err != nil {
		return fmt.Errorf("import stopped: %w", err)
	}
	return nil
}

// flush writes the pending chunk in one transaction and then reports progress.
func (r *Runner) flush(ctx context.Context, st *runState) error {
	if len(st.chunk) == 0 {
		return nil
	}
	if err := st.interrupted(ctx); err != nil {
		return err
	}
	pr := st.prog
	pr.Imported += int64(len(st.chunk))
	ids, err := r.cfg.Store.ImportChunk(ctx, db.ImportChunkParams{
		JobID: st.jobID, ChannelID: st.channelID, AuthorID: st.account,
		Messages: st.chunk, KnownIDs: st.ids, Progress: pr,
	})
	if err != nil {
		return err
	}
	for k, v := range ids {
		st.ids[k] = v
		st.lastID = max(st.lastID, v)
	}
	st.prog = pr
	st.chunk = st.chunk[:0]
	st.chunkBytes, st.chunkSince = 0, time.Time{}
	st.chunks++
	if r.afterChunk != nil {
		r.afterChunk(ctx, st.chunks)
	}
	return nil
}
