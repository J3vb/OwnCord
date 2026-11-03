package db_test

import (
	"os"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// namedQuery returns the text of the sqlc query called name in a query file,
// so a plan test reads the statement sqlc generates from, not a copy.
func namedQuery(t *testing.T, file, name string) string {
	t.Helper()
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("read %s: %v", file, err)
	}
	_, rest, ok := strings.Cut(string(raw), "-- name: "+name+" ")
	if !ok {
		t.Fatalf("query %s not found in %s", name, file)
	}
	if next := strings.Index(rest, "-- name: "); next >= 0 {
		rest = rest[:next]
	}
	var sb strings.Builder
	for i, line := range strings.Split(rest, "\n") {
		if i == 0 || strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		sb.WriteString(line)
		sb.WriteByte('\n')
	}
	return strings.TrimSuffix(strings.TrimSpace(sb.String()), ";")
}

func assertNoAttachmentScan(t *testing.T, label string, plan []string) {
	t.Helper()
	for _, step := range plan {
		if strings.HasPrefix(step, "SCAN attachments") {
			t.Errorf("%s scans attachments; plan:\n%s", label, strings.Join(plan, "\n"))
			return
		}
	}
}

func planHas(plan []string, want string) bool {
	for _, step := range plan {
		if strings.Contains(step, want) {
			return true
		}
	}
	return false
}

// Storage reconciliation and the admin leftover scan look up every listed file
// by name, and each removal asks whether a row still names a file: on a big
// server a scan per lookup cost seconds per tick.
func TestStoredNameLookups_PlanUsesStoredAsIndex(t *testing.T) {
	database := openMigratedMemory(t)
	names := []any{"a.png", "b.png", "c.png"}
	args := append(append(append([]any{}, names...), names...), names...)
	plan := queryPlan(t, database, db.ReferencedStoredFilesSQLForTest(len(names)), args...)
	assertNoAttachmentScan(t, "ReferencedStoredFiles", plan)
	if !planHas(plan, "SEARCH attachments USING COVERING INDEX idx_attachments_stored_as") {
		t.Errorf("ReferencedStoredFiles does not seek idx_attachments_stored_as; plan:\n%s", strings.Join(plan, "\n"))
	}

	plan = queryPlan(t, database, db.AttachmentStoredNameInUseSQLForTest, "a.png")
	assertNoAttachmentScan(t, "AttachmentStoredNameInUse", plan)
	if !planHas(plan, "SEARCH attachments USING COVERING INDEX idx_attachments_stored_as") {
		t.Errorf("AttachmentStoredNameInUse does not seek idx_attachments_stored_as; plan:\n%s", strings.Join(plan, "\n"))
	}
}

// The orphan sweep runs on the writer every tick: each half must seek its
// rows by message_id instead of reading every attachment.
func TestOrphanSweep_PlansSeekByMessage(t *testing.T) {
	database := openMigratedMemory(t)
	const file = "queries/sqlite/attachments.sql"
	for name, want := range map[string][]string{
		"DeleteUnlinkedOrphanedAttachments": {"SEARCH attachments USING INDEX idx_attachments_message (message_id=?)"},
		"DeleteDeletedMessageAttachments": {
			"SEARCH attachments USING INDEX idx_attachments_message (message_id=?)",
			"idx_messages_deleted",
		},
	} {
		plan := queryPlan(t, database, namedQuery(t, file, name), "2026-01-01 00:00:00")
		assertNoAttachmentScan(t, name, plan)
		for _, w := range want {
			if !planHas(plan, w) {
				t.Errorf("%s plan lacks %q:\n%s", name, w, strings.Join(plan, "\n"))
			}
		}
	}
}

// The admin and own upload lists page newest first; the sort must come from
// idx_attachments_uploaded_at instead of sorting every row.
func TestUploadListNewestFirst_PlanUsesUploadedAtIndex(t *testing.T) {
	database := openMigratedMemory(t)
	plan := queryPlan(t, database, `SELECT a.id FROM attachments a
		LEFT JOIN messages m ON m.id = a.message_id
		ORDER BY a.uploaded_at DESC, a.id DESC LIMIT ?`, 50)
	if !planHas(plan, "idx_attachments_uploaded_at") || planHas(plan, "TEMP B-TREE") {
		t.Errorf("newest-first page does not read idx_attachments_uploaded_at in order; plan:\n%s", strings.Join(plan, "\n"))
	}
}
