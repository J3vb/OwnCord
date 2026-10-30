package db

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// AbandonImport deletes the pending channel and its messages and marks the job
// failed or cancelled; copied files stay as unlinked rows for the orphan sweep.
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

// failStaleImports fails every running job not named in live and deletes its
// pending channel.
func failStaleImports(ctx context.Context, q *dbgen.Queries, live []int64) error {
	jobs, err := q.ListRunningImportJobs(ctx)
	if err != nil {
		return err
	}
	for _, j := range jobs {
		if slices.Contains(live, j.ID) {
			continue
		}
		var chID int64
		if j.ChannelID != nil {
			chID = *j.ChannelID
		}
		prog, err := q.GetImportJob(ctx, j.ID)
		if err != nil {
			return err
		}
		if err := abandonImportTx(ctx, q, j.ID, chID, ImportFailed, ImportAbandonedMessage, ImportProgress{
			Total: prog.Total, Imported: prog.Imported, Skipped: prog.Skipped, SkippedAttachments: prog.SkippedAttachments,
		}); err != nil {
			return err
		}
	}
	return nil
}

// maxChannelNameRunes mirrors the channel name cap the admin routes enforce.
const maxChannelNameRunes = 100

// uniquifyImportChannelName appends " (imported)", then " (imported 2)" and so
// on until the name is unique among the category's visible text channels. It
// runs inside the publishing transaction.
func uniquifyImportChannelName(ctx context.Context, q *dbgen.Queries, channelID int64) error {
	place, err := q.GetImportChannelPlacement(ctx, channelID)
	if err != nil {
		return err
	}
	var cat int64
	if place.CategoryID != nil {
		cat = *place.CategoryID
	}
	names, err := q.ListVisibleChannelNamesInCategory(ctx, dbgen.ListVisibleChannelNamesInCategoryParams{
		SelfID: channelID, CategoryID: &cat,
	})
	if err != nil {
		return err
	}
	// The same case folding the admin create route uses.
	taken := func(name string) bool {
		return slices.ContainsFunc(names, func(other string) bool { return strings.EqualFold(other, name) })
	}
	if !taken(place.Name) {
		return nil
	}
	for i := 1; i <= 1000; i++ {
		suffix := " (imported)"
		if i > 1 {
			suffix = fmt.Sprintf(" (imported %d)", i)
		}
		base := []rune(place.Name)
		if room := maxChannelNameRunes - len([]rune(suffix)); len(base) > room {
			base = base[:room]
		}
		candidate := strings.TrimSpace(string(base)) + suffix
		if !taken(candidate) {
			return q.RenameImportChannel(ctx, dbgen.RenameImportChannelParams{Name: candidate, ID: channelID})
		}
	}
	return fmt.Errorf("%w: no free name for the imported channel %q", ErrConflict, place.Name)
}
