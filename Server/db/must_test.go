package db_test

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
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	return v
}

// mustCreateMessage calls CreateMessage and fails the test on error.
func mustCreateMessage(t testing.TB, database *db.DB, channelID, userID int64, content string, replyTo *int64) int64 {
	t.Helper()
	v, err := database.CreateMessage(context.Background(), channelID, userID, content, replyTo)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	return v
}

// mustCreateChannel calls CreateChannel and fails the test on error.
func mustCreateChannel(t testing.TB, database *db.DB, name, chanType, category, topic string, position int) int64 {
	t.Helper()
	v, err := database.CreateChannel(context.Background(), name, chanType, category, topic, position)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	return v
}

// mustCreateMessageWithMentions calls CreateMessageWithMentions and fails the test on error.
func mustCreateMessageWithMentions(t testing.TB, database *db.DB, channelID, userID int64, content string, replyTo *int64, mentionedUserIDs []int64, replyPingUserID int64, mentionsEveryone bool, mentionedRoleIDs []int64) *db.Message {
	t.Helper()
	v, err := database.CreateMessageWithMentions(context.Background(), channelID, userID, content, replyTo, mentionedUserIDs, replyPingUserID, mentionsEveryone, mentionedRoleIDs)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	return v
}

// mustGetAppeal calls GetAppeal and fails the test on error.
func mustGetAppeal(t testing.TB, database *db.DB, id int64) *db.Appeal {
	t.Helper()
	v, err := database.GetAppeal(context.Background(), id)
	if err != nil {
		t.Fatalf("GetAppeal: %v", err)
	}
	return v
}

// mustGetUserByID calls GetUserByID and fails the test on error.
func mustGetUserByID(t testing.TB, database *db.DB, id int64) *db.User {
	t.Helper()
	v, err := database.GetUserByID(context.Background(), id)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	return v
}

// mustGetUserDMChannels calls GetUserDMChannels and fails the test on error.
func mustGetUserDMChannels(t testing.TB, database *db.DB, userID int64) []db.DMChannelInfo {
	t.Helper()
	v, err := database.GetUserDMChannels(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetUserDMChannels: %v", err)
	}
	return v
}

// mustGetVoiceState calls GetVoiceState and fails the test on error.
func mustGetVoiceState(t testing.TB, database *db.DB, userID int64) *db.VoiceState {
	t.Helper()
	v, err := database.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	return v
}

// mustGetChannel calls GetChannel and fails the test on error.
func mustGetChannel(t testing.TB, database *db.DB, id int64) *db.Channel {
	t.Helper()
	v, err := database.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	return v
}

// mustGetReport calls GetReport and fails the test on error.
func mustGetReport(t testing.TB, database *db.DB, id int64) *db.Report {
	t.Helper()
	v, err := database.GetReport(context.Background(), id)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	return v
}

// mustListModerationActionsForTarget calls ListModerationActionsForTarget and fails the test on error.
func mustListModerationActionsForTarget(t testing.TB, database *db.DB, targetID int64) []db.ModerationAction {
	t.Helper()
	v, err := database.ListModerationActionsForTarget(context.Background(), targetID)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	return v
}

// mustGetMessageRequestByPair calls GetMessageRequestByPair and fails the test on error.
func mustGetMessageRequestByPair(t testing.TB, database *db.DB, senderID, recipientID int64) *db.MessageRequest {
	t.Helper()
	v, err := database.GetMessageRequestByPair(context.Background(), senderID, recipientID)
	if err != nil {
		t.Fatalf("GetMessageRequestByPair: %v", err)
	}
	return v
}

// mustCreateRole calls CreateRole and fails the test on error.
func mustCreateRole(t testing.TB, database *db.DB, name string, color *string, perms int64, position int, hoist, mentionable bool) *db.Role {
	t.Helper()
	v, err := database.CreateRole(context.Background(), name, color, perms, position, hoist, mentionable)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	return v
}
