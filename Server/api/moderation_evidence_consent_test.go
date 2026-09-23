package api_test

// moderation_evidence_consent_test.go proves the B5-7/B5-8 follow-up (the
// B5 plan's audit carryover for exit conditions 3 and 4): a report's
// evidence snapshot and the files it references reach a moderator only
// under the moderator's own, current NSFW acknowledgement of the source
// channel. Both reads go through the real routes — GET
// /api/v1/moderation/queue/{id} for the text and GET /api/v1/files/{id} for
// the attachment — with the consent changes made through the real
// acknowledge/revoke routes and ChannelService's relabel and delete.

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

const (
	evidenceSecretText  = "labelled-evidence-text"
	evidenceFileContent = "labelled-evidence-file"
)

type evidenceFixture struct {
	t        *testing.T
	h        http.Handler
	database *db.DB
	svc      *service.Services
	channel  int64
	fileID   string
	reportID string
}

// newEvidenceFixture builds a labelled channel holding one message with one
// attachment, and a report on that message filed through the intake route
// by a reporter who acknowledged the label first (intake itself runs the
// consent-gated channel read). targetType picks a message or an attachment
// report; both snapshot the same text and file reference.
func newEvidenceFixture(t *testing.T, targetType string, labelled bool) *evidenceFixture {
	t.Helper()
	database := newModQueueActTestDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	r := chi.NewRouter()
	api.MountReportRoutes(r, svc, &recordingModQueueBroadcaster{})
	api.MountModerationQueueRoutes(r, svc, &recordingModQueueBroadcaster{})
	api.MountNSFWRoutes(r, svc, &mockBroadcaster{})
	api.MountUploadRoutes(r, svc.Sessions, newUploadTestStorage(t), auth.NewRateLimiter(), nil, svc.Uploads)
	f := &evidenceFixture{t: t, h: r, database: database, svc: svc}
	ctx := context.Background()

	chID, err := database.CreateChannel(ctx, "evidence-src", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	f.channel = chID
	nsfwSetLabel(t, database, chID, labelled)

	authorID := mintUser(t, database, "ev-author")
	authorToken, _ := mintSession(t, database, authorID)
	rr := doUpload(t, r, authorToken, "file", "evidence.txt", []byte(evidenceFileContent))
	if rr.Code != http.StatusCreated && rr.Code != http.StatusOK {
		t.Fatalf("upload: status %d, body %s", rr.Code, rr.Body.String())
	}
	var up struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &up); err != nil || up.ID == "" {
		t.Fatalf("upload response %s: %v", rr.Body.String(), err)
	}
	f.fileID = up.ID
	msgID, err := database.CreateMessage(ctx, chID, authorID, evidenceSecretText, nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if n, err := database.LinkAttachmentsToMessage(ctx, msgID, authorID, []string{up.ID}); err != nil || n != 1 {
		t.Fatalf("LinkAttachmentsToMessage = (%d, %v), want (1, nil)", n, err)
	}

	reporterID := mintUser(t, database, "ev-reporter")
	reporterToken, _ := mintSession(t, database, reporterID)
	if labelled {
		f.ack(reporterToken)
	}
	targetID := itoa(msgID)
	if targetType == "attachment" {
		targetID = up.ID
	}
	status, body := actJSON(t, r, http.MethodPost, "/api/v1/reports", reporterToken,
		`{"target_type":"`+targetType+`","target_id":"`+targetID+`","reason":"nsfw_unlabelled"}`)
	if status != http.StatusCreated {
		t.Fatalf("file report: status %d, body %s", status, body)
	}
	var filed struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &filed); err != nil {
		t.Fatalf("decode filed report: %v", err)
	}
	f.reportID = filed.ID
	return f
}

func (f *evidenceFixture) ack(token string) {
	f.t.Helper()
	if rr := nsfwDo(f.t, f.h, http.MethodPut, nsfwPath(f.channel), token); rr.Code != http.StatusNoContent {
		f.t.Fatalf("acknowledge: status %d, body %s", rr.Code, rr.Body.String())
	}
}

func (f *evidenceFixture) revoke(token string) {
	f.t.Helper()
	if rr := nsfwDo(f.t, f.h, http.MethodDelete, nsfwPath(f.channel), token); rr.Code != http.StatusNoContent {
		f.t.Fatalf("revoke: status %d, body %s", rr.Code, rr.Body.String())
	}
}

// relabel sets the label through ChannelService.AdminUpdateChannel — the
// path that clears acknowledgements when the resulting flag is off.
func (f *evidenceFixture) relabel(nsfw bool) {
	f.t.Helper()
	ctx := context.Background()
	ch, err := f.database.GetChannel(ctx, f.channel)
	if err != nil || ch == nil {
		f.t.Fatalf("GetChannel: %v", err)
	}
	if _, err := f.svc.Channels.AdminUpdateChannel(ctx, 0, ch, service.AdminChannelUpdate{
		Name: ch.Name, Topic: ch.Topic, Category: ch.Category, Position: ch.Position, NSFW: nsfw,
	}, nil); err != nil {
		f.t.Fatalf("AdminUpdateChannel(nsfw=%v): %v", nsfw, err)
	}
}

func (f *evidenceFixture) deleteChannel() {
	f.t.Helper()
	ctx := context.Background()
	ch, err := f.database.GetChannel(ctx, f.channel)
	if err != nil || ch == nil {
		f.t.Fatalf("GetChannel: %v", err)
	}
	if _, err := f.svc.Channels.AdminDeleteChannel(ctx, 0, ch, nil); err != nil {
		f.t.Fatalf("AdminDeleteChannel: %v", err)
	}
}

// moderator mints a MODERATE_MEMBERS holder (plus READ_MESSAGES, see
// mintModerator) with extra bits, and a session for them.
func (f *evidenceFixture) moderator(name string, extra int64) string {
	f.t.Helper()
	id := mintModerator(f.t, f.database, name, 60, permissions.ModerateMembers|extra)
	token, _ := mintSession(f.t, f.database, id)
	return token
}

// expectEvidence asserts GET queue/{id}: readable (withheld == "") means the
// snapshot carries the text and the file reference; withheld means no
// snapshot row and no snapshot text anywhere in the body, and
// evidence_withheld names the reason.
func (f *evidenceFixture) expectEvidence(token, withheld string) {
	f.t.Helper()
	status, body := bearerDo(f.t, f.h, http.MethodGet, "/api/v1/moderation/queue/"+f.reportID, token, nil)
	if status != http.StatusOK {
		f.t.Fatalf("GET report: status %d, body %s", status, body)
	}
	var detail struct {
		Evidence []struct {
			Content     string `json:"content"`
			Attachments string `json:"attachments"`
		} `json:"evidence"`
		EvidenceWithheld string `json:"evidence_withheld"`
	}
	if err := json.Unmarshal(body, &detail); err != nil {
		f.t.Fatalf("decode report: %v", err)
	}
	if detail.EvidenceWithheld != withheld {
		f.t.Fatalf("evidence_withheld = %q, want %q; body %s", detail.EvidenceWithheld, withheld, body)
	}
	if withheld != "" {
		// An attachment report's target_ref is the file id itself — a
		// reference, not content: the file read below is gated on its own.
		if len(detail.Evidence) != 0 || strings.Contains(string(body), evidenceSecretText) {
			f.t.Fatalf("withheld evidence leaked into the report body: %s", body)
		}
		return
	}
	var text, ref bool
	for _, e := range detail.Evidence {
		text = text || e.Content == evidenceSecretText
		ref = ref || strings.Contains(e.Attachments, f.fileID)
	}
	if !text || !ref {
		f.t.Fatalf("readable evidence missing text (%v) or file reference (%v): %s", text, ref, body)
	}
}

// expectFile asserts GET /api/v1/files/{id}: 200 with the bytes, or the
// given status and error code with none of them.
func (f *evidenceFixture) expectFile(token string, wantStatus int, wantCode string) {
	f.t.Helper()
	rr := doServeFile(f.t, f.h, f.fileID, token, nil)
	if rr.Code != wantStatus {
		f.t.Fatalf("GET file: status %d, want %d; body %s", rr.Code, wantStatus, rr.Body.String())
	}
	if wantStatus == http.StatusOK {
		if rr.Body.String() != evidenceFileContent {
			f.t.Fatalf("GET file: body %q, want the uploaded bytes", rr.Body.String())
		}
		return
	}
	if strings.Contains(rr.Body.String(), evidenceFileContent) {
		f.t.Fatalf("refused file read leaked its bytes: %s", rr.Body.String())
	}
	var e struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &e)
	if e.Error != wantCode {
		f.t.Fatalf("GET file: error %q, want %q", e.Error, wantCode)
	}
}

const nsfwAckRequired = service.EvidenceNSFWAcknowledgementRequired

// TestModerationEvidence_AcknowledgeAndRevoke: an unacknowledged moderator
// is refused both reads; acknowledging grants both; revoking refuses both
// again on the very next read.
func TestModerationEvidence_AcknowledgeAndRevoke(t *testing.T) {
	for _, target := range []string{"message", "attachment"} {
		t.Run(target, func(t *testing.T) {
			f := newEvidenceFixture(t, target, true)
			mod := f.moderator("ev-mod", 0)

			f.expectEvidence(mod, nsfwAckRequired)
			f.expectFile(mod, http.StatusForbidden, "NSFW_ACKNOWLEDGEMENT_REQUIRED")

			f.ack(mod)
			f.expectEvidence(mod, "")
			f.expectFile(mod, http.StatusOK, "")

			f.revoke(mod)
			f.expectEvidence(mod, nsfwAckRequired)
			f.expectFile(mod, http.StatusForbidden, "NSFW_ACKNOWLEDGEMENT_REQUIRED")
		})
	}
}

// TestModerationEvidence_ConsentIsPerModerator: one moderator's
// acknowledgement does not open the evidence to another, and the reporter's
// own acknowledgement (given to file) opens it to nobody else.
func TestModerationEvidence_ConsentIsPerModerator(t *testing.T) {
	f := newEvidenceFixture(t, "message", true)
	acked := f.moderator("ev-mod-a", 0)
	other := f.moderator("ev-mod-b", 0)

	f.ack(acked)
	f.expectEvidence(acked, "")
	f.expectFile(acked, http.StatusOK, "")
	f.expectEvidence(other, nsfwAckRequired)
	f.expectFile(other, http.StatusForbidden, "NSFW_ACKNOWLEDGEMENT_REQUIRED")
}

// TestModerationEvidence_AdministratorHasNoBypass: decision 13 — the
// Administrator bit reads labelled evidence only with its own
// acknowledgement, exactly like a moderator.
func TestModerationEvidence_AdministratorHasNoBypass(t *testing.T) {
	f := newEvidenceFixture(t, "message", true)
	admin := f.moderator("ev-admin", permissions.Administrator)

	f.expectEvidence(admin, nsfwAckRequired)
	f.expectFile(admin, http.StatusForbidden, "NSFW_ACKNOWLEDGEMENT_REQUIRED")

	f.ack(admin)
	f.expectEvidence(admin, "")
	f.expectFile(admin, http.StatusOK, "")
}

// TestModerationEvidence_SourceChannelRelabelling: the label is read live.
// Unlabelling makes the snapshot ordinary content (and clears standing
// acknowledgements); labelling again refuses everyone until they
// acknowledge the new label. A label added after the report was filed
// gates it too.
func TestModerationEvidence_SourceChannelRelabelling(t *testing.T) {
	t.Run("unlabel then relabel", func(t *testing.T) {
		f := newEvidenceFixture(t, "message", true)
		mod := f.moderator("ev-mod", 0)
		f.ack(mod)
		f.expectEvidence(mod, "")

		f.relabel(false)
		f.expectEvidence(mod, "")
		f.expectFile(mod, http.StatusOK, "")

		f.relabel(true)
		f.expectEvidence(mod, nsfwAckRequired)
		f.expectFile(mod, http.StatusForbidden, "NSFW_ACKNOWLEDGEMENT_REQUIRED")

		f.ack(mod)
		f.expectEvidence(mod, "")
		f.expectFile(mod, http.StatusOK, "")
	})
	t.Run("labelled after filing", func(t *testing.T) {
		f := newEvidenceFixture(t, "message", false)
		mod := f.moderator("ev-mod", 0)
		f.expectEvidence(mod, "")
		f.expectFile(mod, http.StatusOK, "")

		f.relabel(true)
		f.expectEvidence(mod, nsfwAckRequired)
		f.expectFile(mod, http.StatusForbidden, "NSFW_ACKNOWLEDGEMENT_REQUIRED")
	})
}

// TestModerationEvidence_SourceChannelDeletion: a deleted source channel
// leaves no label to read and no acknowledgement to hold, so the snapshot
// is withheld even from a moderator who had acknowledged, and the file —
// unlinked by the cascade — is refused to them as well.
func TestModerationEvidence_SourceChannelDeletion(t *testing.T) {
	f := newEvidenceFixture(t, "message", true)
	mod := f.moderator("ev-mod", 0)
	f.ack(mod)
	f.expectEvidence(mod, "")

	f.deleteChannel()
	f.expectEvidence(mod, service.EvidenceSourceChannelUnavailable)
	f.expectFile(mod, http.StatusForbidden, "FORBIDDEN")
}

// TestModerationEvidence_UnlabelledSourceNeedsNoAcknowledgement is the
// control: an ordinary channel's evidence reaches a moderator with no
// acknowledgement at all.
func TestModerationEvidence_UnlabelledSourceNeedsNoAcknowledgement(t *testing.T) {
	f := newEvidenceFixture(t, "message", false)
	mod := f.moderator("ev-mod", 0)
	f.expectEvidence(mod, "")
	f.expectFile(mod, http.StatusOK, "")
}
