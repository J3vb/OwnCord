package service

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// mustDo fails the test, naming the operation, when err is non-nil.
func mustDo(t testing.TB, operation string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", operation, err)
	}
}

// mustCreateUser calls CreateUser and fails the test on error.
func mustCreateUser(t testing.TB, database *db.DB, username, passwordHash string, roleID int) int64 {
	t.Helper()
	v, err := database.CreateUser(context.Background(), username, passwordHash, roleID)
	return mustResult(t, "CreateUser", v, err)
}

// mustCreateMessage calls CreateMessage and fails the test on error.
func mustCreateMessage(t testing.TB, database *db.DB, channelID, userID int64, content string, replyTo *int64) int64 {
	t.Helper()
	v, err := database.CreateMessage(context.Background(), channelID, userID, content, replyTo)
	return mustResult(t, "CreateMessage", v, err)
}

// mustCreateChannel calls CreateChannel and fails the test on error.
func mustCreateChannel(t testing.TB, database *db.DB, name, chanType, category, topic string, position int) int64 {
	t.Helper()
	v, err := database.CreateChannel(context.Background(), name, chanType, category, topic, position)
	return mustResult(t, "CreateChannel", v, err)
}

// mustGetUserByID calls GetUserByID and fails the test on error.
func mustGetUserByID(t testing.TB, database *db.DB, id int64) *db.User {
	t.Helper()
	v, err := database.GetUserByID(context.Background(), id)
	return mustResult(t, "GetUserByID", v, err)
}

// mustGetReport calls GetReport and fails the test on error.
func mustGetReport(t testing.TB, database *db.DB, id int64) *db.Report {
	t.Helper()
	v, err := database.GetReport(context.Background(), id)
	return mustResult(t, "GetReport", v, err)
}

// mustListModerationActionsForTarget calls ListModerationActionsForTarget and fails the test on error.
func mustListModerationActionsForTarget(t testing.TB, database *db.DB, targetID int64) []db.ModerationAction {
	t.Helper()
	v, err := database.ListModerationActionsForTarget(context.Background(), targetID)
	return mustResult(t, "ListModerationActionsForTarget", v, err)
}

// mustGetAuditLog calls GetAuditLog and fails the test on error.
func mustGetAuditLog(t testing.TB, database *db.DB, limit, offset int) []db.AuditEntry {
	t.Helper()
	v, err := database.GetAuditLog(context.Background(), limit, offset)
	return mustResult(t, "GetAuditLog", v, err)
}

// mustHaveActiveTimeout calls HasActiveTimeout and fails the test on error.
func mustHaveActiveTimeout(t testing.TB, database *db.DB, userID int64) bool {
	t.Helper()
	v, err := database.HasActiveTimeout(context.Background(), userID)
	return mustResult(t, "HasActiveTimeout", v, err)
}

// mustListReportEvidence calls ListReportEvidence and fails the test on error.
func mustListReportEvidence(t testing.TB, database *db.DB, reportID int64) []db.ReportEvidenceRow {
	t.Helper()
	v, err := database.ListReportEvidence(context.Background(), reportID)
	return mustResult(t, "ListReportEvidence", v, err)
}

// mustCreateSession calls CreateSession and fails the test on error.
func mustCreateSession(t testing.TB, database *db.DB, userID int64, tokenHash, device, ip string) int64 {
	t.Helper()
	v, err := database.CreateSession(context.Background(), userID, tokenHash, device, ip)
	return mustResult(t, "CreateSession", v, err)
}

// mustGetMentionsByMessageIDs calls GetMentionsByMessageIDs and fails the test on error.
func mustGetMentionsByMessageIDs(t testing.TB, database *db.DB, msgIDs []int64) map[int64][]int64 {
	t.Helper()
	v, err := database.GetMentionsByMessageIDs(context.Background(), msgIDs)
	return mustResult(t, "GetMentionsByMessageIDs", v, err)
}

// mustGetReactions calls GetReactions and fails the test on error.
func mustGetReactions(t testing.TB, database *db.DB, messageID int64) []db.ReactionCount {
	t.Helper()
	v, err := database.GetReactions(context.Background(), messageID)
	return mustResult(t, "GetReactions", v, err)
}

// mustGetChannelUnreadCounts calls GetChannelUnreadCounts and fails the test on error.
func mustGetChannelUnreadCounts(t testing.TB, database *db.DB, userID int64) map[int64]db.ChannelUnread {
	t.Helper()
	v, err := database.GetChannelUnreadCounts(context.Background(), userID)
	return mustResult(t, "GetChannelUnreadCounts", v, err)
}

// mustResult returns v, failing the test when the call that produced it
// returned an error.
func mustResult[T any](t testing.TB, operation string, v T, err error) T {
	t.Helper()
	mustDo(t, operation, err)
	return v
}

// mustSendMessage sends a message through svc and fails the test on error.
func mustSendMessage(ctx context.Context, t testing.TB, svc *MessageService, p SendMessageParams) *SendMessageResult {
	t.Helper()
	res, err := svc.SendMessage(ctx, p)
	return mustResult(t, "SendMessage", res, err)
}
