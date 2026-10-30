package discordimport

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// ErrNotFound is returned for a job or category that does not exist.
var ErrNotFound = db.ErrNotFound

// ErrNotRunning is returned by Cancel for a job that has already ended.
var ErrNotRunning = errors.New("that import is not running")

// Job states, as JobView.Status reports them.
const (
	StatusRunning   = db.ImportRunning
	StatusDone      = db.ImportDone
	StatusFailed    = db.ImportFailed
	StatusCancelled = db.ImportCancelled
)

const maxAuditSourceRunes = 100

// JobView is a job as the admin routes show it.
type JobView struct {
	ID                 int64
	Status             string
	SourceName         string
	Imported           int64
	Skipped            int64
	SkippedAttachments int64
	Total              int64
	Error              *string
	CreatedAt          string
	FinishedAt         *string
}

func viewOf(j *db.ImportJob) JobView {
	return JobView{
		ID: j.ID, Status: j.Status, SourceName: j.SourceName, Imported: j.Imported, Skipped: j.Skipped,
		SkippedAttachments: j.SkippedAttachments, Total: j.Total, Error: j.Error,
		CreatedAt: j.CreatedAt, FinishedAt: j.FinishedAt,
	}
}

// ServiceStore is the database surface the Service needs: the runner's plus the
// audit log. *db.DB satisfies it.
type ServiceStore interface {
	Store
	db.Auditor
}

// ChannelBroadcaster sends channel_create; *ws.Hub satisfies it.
type ChannelBroadcaster interface {
	BroadcastChannelCreate(ch *db.Channel)
}

// PermissionCache drops cached permissions; *service.PermissionService satisfies
// it.
type PermissionCache interface {
	InvalidateAll()
}

// ServiceConfig wires a Service. Store, Files and Uploads are the runner's
// (Config); Hub and Perms announce the finished channel.
type ServiceConfig struct {
	Store   ServiceStore
	Files   Files
	Uploads Uploads
	Group   *syncutil.Group
	Hub     ChannelBroadcaster
	Perms   PermissionCache
}

// Service is what the admin routes drive: the runner plus the audit rows and
// the announcement that go with an import.
type Service struct {
	runner *Runner
	audit  db.Auditor
	group  *syncutil.Group

	// cancelledBy remembers who asked to cancel a job, for the audit row
	// written once the job really ended cancelled.
	cancelMu    syncutil.Mutex
	cancelledBy map[int64]int64
}

// NewService returns a Service.
func NewService(cfg ServiceConfig) *Service {
	return &Service{
		runner: NewRunner(Config{
			Store: cfg.Store, Files: cfg.Files, Uploads: cfg.Uploads, Group: cfg.Group,
			Announcer: channelAnnouncer{perms: cfg.Perms, hub: cfg.Hub},
		}),
		audit:       cfg.Store,
		group:       cfg.Group,
		cancelledBy: map[int64]int64{},
	}
}

// channelAnnouncer tells everyone about a finished import's channel the way a
// normal channel create does.
type channelAnnouncer struct {
	perms PermissionCache
	hub   ChannelBroadcaster
}

// ChannelCreated drops cached permissions, since the channel started as a copy
// of its category's template, and then sends channel_create.
func (a channelAnnouncer) ChannelCreated(_ context.Context, ch *db.Channel) {
	if a.perms != nil {
		a.perms.InvalidateAll()
	}
	if a.hub != nil {
		a.hub.BroadcastChannelCreate(ch)
	}
}

// Start begins an import and audits it. When the job ends it audits a published
// or cancelled one.
func (s *Service) Start(ctx context.Context, req Request) (*Job, error) {
	job, err := s.runner.Start(ctx, req)
	if err != nil {
		return nil, err
	}
	source := auditSource(req.SourceName)
	db.WriteAudit(context.WithoutCancel(ctx), s.audit, req.CreatedBy, "discord_import_start", "channel", job.ChannelID, "started importing "+source)
	watch := func(ctx context.Context) { s.auditEnd(ctx, job, req.CreatedBy, source) }
	if !s.group.Go(ctx, watch) {
		job.Cancel()
		<-job.Done()
		s.auditEnd(ctx, job, req.CreatedBy, source)
	}
	return job, nil
}

// auditEnd waits for the job and writes the audit row for how it ended. At
// shutdown it leaves without waiting.
func (s *Service) auditEnd(ctx context.Context, job *Job, actor int64, source string) {
	select {
	case <-job.Done():
	case <-ctx.Done():
		return
	}
	res := job.Wait()
	s.cancelMu.Lock()
	by, asked := s.cancelledBy[job.ID]
	delete(s.cancelledBy, job.ID)
	s.cancelMu.Unlock()
	tail := context.WithoutCancel(ctx)
	switch res.Status {
	case StatusDone:
		db.WriteAudit(tail, s.audit, actor, "discord_import_publish", "channel", job.ChannelID,
			fmt.Sprintf("published %s: %d messages imported, %d skipped", source, res.Imported, res.Skipped))
	case StatusCancelled:
		if asked {
			db.WriteAudit(tail, s.audit, by, "discord_import_cancel", "channel", job.ChannelID, "cancelled importing "+source)
		}
	}
}

// Cancel asks a running job to stop. The cancel audit row is written when the
// job actually ends cancelled, so a cancel that loses a race with the publish
// leaves none. ErrNotFound for an unknown id, ErrNotRunning for a finished one.
func (s *Service) Cancel(ctx context.Context, id, actor int64) error {
	job := s.runner.Running(id)
	if job != nil {
		select {
		case <-job.Done():
			job = nil
		default:
		}
	}
	if job == nil {
		if _, err := s.runner.Status(ctx, id); err != nil {
			return err
		}
		return ErrNotRunning
	}
	s.cancelMu.Lock()
	s.cancelledBy[id] = actor
	s.cancelMu.Unlock()
	job.Cancel()
	return nil
}

// Running returns the job with that id while it is running here, else nil.
func (s *Service) Running(id int64) *Job { return s.runner.Running(id) }

// Status returns a job's stored state; ErrNotFound when there is none.
func (s *Service) Status(ctx context.Context, id int64) (JobView, error) {
	j, err := s.runner.Status(ctx, id)
	if err != nil {
		return JobView{}, err
	}
	return viewOf(j), nil
}

// Latest returns the newest job's stored state; ErrNotFound when none ran.
func (s *Service) Latest(ctx context.Context) (JobView, error) {
	j, err := s.runner.Latest(ctx)
	if err != nil {
		return JobView{}, err
	}
	return viewOf(j), nil
}

// CategoryExists reports whether a category can hold the import's channel.
func (s *Service) CategoryExists(ctx context.Context, id int64) (bool, error) {
	return s.runner.CategoryExists(ctx, id)
}

// auditSource is the upload's file name made safe and short for an audit row.
func auditSource(name string) string {
	s := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	if r := []rune(s); len(r) > maxAuditSourceRunes {
		s = string(r[:maxAuditSourceRunes])
	}
	return s
}
