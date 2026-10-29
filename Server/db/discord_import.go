package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/dbtime"
)

// The Discord import writes a whole channel of history that must look like it
// was always there. Everything here is the db half: the service package
// parses the export and drives these calls. A channel is built with
// import_pending = 1, which every client-facing channel read skips, filled
// chunk by chunk, and published in one transaction.

// ErrImportRunning is returned by StartImport when another import is still
// running. One import runs at a time.
var ErrImportRunning = errors.New("another import is already running")

// Import job states, as stored in import_jobs.status.
const (
	ImportRunning   = "running"
	ImportDone      = "done"
	ImportFailed    = "failed"
	ImportCancelled = "cancelled"
)

// ImportInterruptedMessage is the error recorded on a job a restart cut short.
const ImportInterruptedMessage = "the server restarted before the import finished"

// importAccountName is the username of the hidden import account. The
// "[imported" prefix is reserved at registration (auth.ValidateUsername).
const importAccountName = "[imported]"

// ImportJob is one row of import_jobs.
type ImportJob struct {
	ID                 int64
	ChannelID          *int64
	CreatedBy          *int64
	SourceName         string
	DiscordChannelID   string
	Status             string
	Total              int64
	Imported           int64
	Skipped            int64
	SkippedAttachments int64
	Error              *string
	CreatedAt          string
	FinishedAt         *string
}

// ImportProgress is the running tally the importer stores on its job.
type ImportProgress struct {
	Total              int64
	Imported           int64
	Skipped            int64
	SkippedAttachments int64
}

// StartImportParams describes the channel and job a new import creates.
type StartImportParams struct {
	// Name and Topic are already cleaned by the caller.
	Name  string
	Topic string
	// CategoryID is the category to place the channel in, 0 for none. An
	// unknown id is ErrNotFound and nothing is written.
	CategoryID int64
	// CreatedBy is the admin who started the import, 0 when unknown.
	CreatedBy        int64
	SourceName       string
	DiscordChannelID string
}

// EnsureImportAccount returns the id of the hidden import account, creating it
// on first use. The account is a users row whose registration_status is
// 'system': it has a password no check can match, no role row, no session, and
// it is not listed, mentioned or reachable by direct message.
func (d *DB) EnsureImportAccount(ctx context.Context) (int64, error) {
	if id, err := d.q.GetImportAccountID(ctx); err == nil {
		return id, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("EnsureImportAccount: %w", err)
	}
	var id int64
	err := d.inWriteTx(ctx, "EnsureImportAccount", func(q *dbgen.Queries) error {
		if existing, err := q.GetImportAccountID(ctx); err == nil {
			id = existing
			return nil
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		res, err := q.CreateImportAccount(ctx, importAccountName)
		if err != nil {
			return err
		}
		if id, err = res.LastInsertId(); err != nil {
			return err
		}
		return q.ClearUserRoles(ctx, id)
	})
	if err == nil {
		return id, nil
	}
	if IsUniqueConstraintError(err) {
		// Another caller created it between the read and the insert.
		if existing, getErr := d.q.GetImportAccountID(ctx); getErr == nil {
			return existing, nil
		}
	}
	return 0, fmt.Errorf("EnsureImportAccount: %w", err)
}

// StartImport creates the pending channel and its running job in one
// transaction. It returns ErrImportRunning when a job is already running.
func (d *DB) StartImport(ctx context.Context, p StartImportParams) (channelID, jobID int64, err error) {
	err = d.inWriteTx(ctx, "StartImport", func(q *dbgen.Queries) error {
		catID, _, catErr := resolveCategoryTx(ctx, q, p.CategoryID, "", false)
		if catErr != nil {
			return catErr
		}
		res, chErr := q.CreateImportChannel(ctx, dbgen.CreateImportChannelParams{
			Name:       p.Name,
			CategoryID: catID,
			Topic:      strToNullPtr(p.Topic),
		})
		if chErr != nil {
			return chErr
		}
		if channelID, chErr = res.LastInsertId(); chErr != nil {
			return chErr
		}
		if catID != nil {
			if tplErr := copyTemplateToNewChannelTx(ctx, q, channelID, *catID); tplErr != nil {
				return tplErr
			}
		}
		var createdBy *int64
		if p.CreatedBy > 0 {
			createdBy = &p.CreatedBy
		}
		jobRes, jobErr := q.InsertImportJob(ctx, dbgen.InsertImportJobParams{
			ChannelID:        &channelID,
			CreatedBy:        createdBy,
			SourceName:       p.SourceName,
			DiscordChannelID: p.DiscordChannelID,
		})
		if jobErr != nil {
			return jobErr
		}
		jobID, jobErr = jobRes.LastInsertId()
		return jobErr
	})
	if err != nil {
		if IsUniqueConstraintError(err) {
			return 0, 0, fmt.Errorf("StartImport: %w", ErrImportRunning)
		}
		return 0, 0, fmt.Errorf("StartImport: %w", err)
	}
	return channelID, jobID, nil
}

// ImportAttachment is a file already stored and recorded (unlinked) for an
// imported message.
type ImportAttachment struct{ ID string }

// ImportMessage is one message of a chunk.
type ImportMessage struct {
	// Key is the message's Discord id. The chunk's result maps it to the new
	// row id so later replies can find it.
	Key string
	// ReplyKey is the Discord id of the message this one replies to, or "".
	ReplyKey string
	Content  string
	// Timestamp and EditedAt are UTC. EditedAt is the zero time when unedited.
	Timestamp time.Time
	EditedAt  time.Time
	Pinned    bool
	// DiscordUserID, AuthorName and AuthorColor fill message_import_authors.
	DiscordUserID string
	AuthorName    string
	AuthorColor   string
	// AttachmentIDs are unlinked attachment rows the import account uploaded.
	AttachmentIDs []string
}

// ImportChunkParams is one writer transaction of an import.
type ImportChunkParams struct {
	JobID     int64
	ChannelID int64
	AuthorID  int64
	Messages  []ImportMessage
	// KnownIDs maps Discord ids of earlier chunks to row ids, for replies.
	KnownIDs map[string]int64
	// Progress is stored on the job in the same transaction as the rows.
	Progress ImportProgress
}

// ImportChunk inserts the messages, their author rows and attachment links, and
// the job's progress in one transaction. It returns the row id of each message
// by Discord id. A reply to a message that is not in KnownIDs or earlier in the
// chunk becomes a plain message.
func (d *DB) ImportChunk(ctx context.Context, p ImportChunkParams) (map[string]int64, error) {
	ids := make(map[string]int64, len(p.Messages))
	err := d.inWriteTx(ctx, "ImportChunk", func(q *dbgen.Queries) error {
		for i := range p.Messages {
			m := &p.Messages[i]
			var replyTo *int64
			if m.ReplyKey != "" {
				if id, ok := ids[m.ReplyKey]; ok {
					replyTo = &id
				} else if id, ok := p.KnownIDs[m.ReplyKey]; ok {
					replyTo = &id
				}
			}
			var editedAt, pinnedAt *string
			if !m.EditedAt.IsZero() {
				s := m.EditedAt.UTC().Format(dbtime.SQLiteLayout)
				editedAt = &s
			}
			if m.Pinned {
				// The same fixed-width stamp SetMessagePinned writes, so pinned
				// messages order the same way.
				s := m.Timestamp.UTC().Format("2006-01-02 15:04:05.000000000")
				pinnedAt = &s
			}
			id, err := q.InsertImportMessage(ctx, dbgen.InsertImportMessageParams{
				ChannelID: p.ChannelID,
				UserID:    p.AuthorID,
				Content:   m.Content,
				ReplyTo:   replyTo,
				EditedAt:  editedAt,
				Pinned:    b2i64(m.Pinned),
				PinnedAt:  pinnedAt,
				Timestamp: m.Timestamp.UTC().Format(dbtime.SQLiteLayout),
			})
			if err != nil {
				return fmt.Errorf("message %d: %w", i, err)
			}
			if err := q.InsertImportAuthor(ctx, dbgen.InsertImportAuthorParams{
				MessageID:     id,
				DiscordUserID: m.DiscordUserID,
				Name:          m.AuthorName,
				Color:         strToNullPtr(m.AuthorColor),
			}); err != nil {
				return fmt.Errorf("author %d: %w", i, err)
			}
			for _, attID := range m.AttachmentIDs {
				n, err := q.LinkImportAttachment(ctx, dbgen.LinkImportAttachmentParams{
					MessageID: &id, ID: attID, UploaderID: &p.AuthorID,
				})
				if err != nil {
					return fmt.Errorf("attachment %s: %w", attID, err)
				}
				if n != 1 {
					return fmt.Errorf("attachment %s: not an unlinked upload of the import account", attID)
				}
			}
			if m.Key != "" {
				ids[m.Key] = id
			}
		}
		return updateImportProgress(ctx, q, p.JobID, p.Progress)
	})
	if err != nil {
		return nil, fmt.Errorf("ImportChunk: %w", err)
	}
	return ids, nil
}

func updateImportProgress(ctx context.Context, q *dbgen.Queries, jobID int64, pr ImportProgress) error {
	n, err := q.UpdateImportJobProgress(ctx, dbgen.UpdateImportJobProgressParams{
		Total: pr.Total, Imported: pr.Imported, Skipped: pr.Skipped,
		SkippedAttachments: pr.SkippedAttachments, ID: jobID,
	})
	if err != nil {
		return err
	}
	if n != 1 {
		return fmt.Errorf("import job %d is not running", jobID)
	}
	return nil
}

// PublishImport makes the finished channel visible. In one transaction it
// clears import_pending, moves every active member's read pointer past
// lastMessageID with no mention count, and marks the job done. It reports
// ErrNotFound when the job is no longer running or the channel is no longer
// pending, in which case nothing is written.
func (d *DB) PublishImport(ctx context.Context, jobID, channelID, lastMessageID int64, pr ImportProgress) error {
	err := d.inWriteTx(ctx, "PublishImport", func(q *dbgen.Queries) error {
		n, err := q.PublishImportChannel(ctx, channelID)
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrNotFound
		}
		if err := q.MarkImportChannelRead(ctx, dbgen.MarkImportChannelReadParams{
			ChannelID: channelID, LastMessageID: lastMessageID,
		}); err != nil {
			return err
		}
		return finishImportJob(ctx, q, jobID, ImportDone, "", pr)
	})
	if err != nil {
		return fmt.Errorf("PublishImport: %w", err)
	}
	return nil
}

func finishImportJob(ctx context.Context, q *dbgen.Queries, jobID int64, status, errText string, pr ImportProgress) error {
	n, err := q.FinishImportJob(ctx, dbgen.FinishImportJobParams{
		Status: status, Error: strToNullPtr(errText), Total: pr.Total, Imported: pr.Imported,
		Skipped: pr.Skipped, SkippedAttachments: pr.SkippedAttachments, ID: jobID,
	})
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrNotFound
	}
	return nil
}

// AbandonImport ends a job that did not finish: it deletes the pending channel
// (its messages go with it) and marks the job failed or cancelled with the
// reason. The files already copied stay as unlinked attachment rows, which the
// orphan sweep reclaims.
func (d *DB) AbandonImport(ctx context.Context, jobID, channelID int64, status, reason string, pr ImportProgress) error {
	if status != ImportFailed && status != ImportCancelled {
		return fmt.Errorf("AbandonImport: status %q is not an ending for an unfinished import", status)
	}
	err := d.inWriteTx(ctx, "AbandonImport", func(q *dbgen.Queries) error {
		return abandonImportTx(ctx, q, jobID, channelID, status, reason, pr)
	})
	if err != nil {
		return fmt.Errorf("AbandonImport: %w", err)
	}
	return nil
}

// abandonImportTx deletes the channel only while it is still pending, so a
// published channel is never removed by a late abandon.
func abandonImportTx(ctx context.Context, q *dbgen.Queries, jobID, channelID int64, status, reason string, pr ImportProgress) error {
	if err := q.DeletePendingImportChannel(ctx, channelID); err != nil {
		return err
	}
	return finishImportJob(ctx, q, jobID, status, reason, pr)
}

// FailInterruptedImports runs at boot. A job still marked running belongs to a
// process that no longer exists, and so does any channel still pending: both
// are cleaned up, so a half import never shows. It returns how many jobs it
// failed.
func (d *DB) FailInterruptedImports(ctx context.Context) (int, error) {
	failed := 0
	err := d.inWriteTx(ctx, "FailInterruptedImports", func(q *dbgen.Queries) error {
		jobs, err := q.ListRunningImportJobs(ctx)
		if err != nil {
			return err
		}
		for _, j := range jobs {
			var chID int64
			if j.ChannelID != nil {
				chID = *j.ChannelID
			}
			prog, err := q.GetImportJob(ctx, j.ID)
			if err != nil {
				return err
			}
			if err := abandonImportTx(ctx, q, j.ID, chID, ImportFailed, ImportInterruptedMessage, ImportProgress{
				Total: prog.Total, Imported: prog.Imported, Skipped: prog.Skipped, SkippedAttachments: prog.SkippedAttachments,
			}); err != nil {
				return err
			}
			failed++
		}
		pending, err := q.ListPendingImportChannelIDs(ctx)
		if err != nil {
			return err
		}
		for _, id := range pending {
			if err := q.DeletePendingImportChannel(ctx, id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("FailInterruptedImports: %w", err)
	}
	return failed, nil
}

// GetImportJob returns one job, ErrNotFound when there is none.
func (d *DB) GetImportJob(ctx context.Context, id int64) (*ImportJob, error) {
	r, err := d.q.GetImportJob(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("GetImportJob %s: %w", strconv.FormatInt(id, 10), ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("GetImportJob: %w", err)
	}
	return &ImportJob{
		ID: r.ID, ChannelID: r.ChannelID, CreatedBy: r.CreatedBy, SourceName: r.SourceName,
		DiscordChannelID: r.DiscordChannelID, Status: r.Status, Total: r.Total, Imported: r.Imported,
		Skipped: r.Skipped, SkippedAttachments: r.SkippedAttachments, Error: r.Error,
		CreatedAt: r.CreatedAt, FinishedAt: r.FinishedAt,
	}, nil
}
