package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// WP 6.8e: CreateMessageRequest reads the recipient's user_privacy inside its
// own transaction and decides between staging and auto-accepting.

func TestCreateMessageRequest_PrivacyDecidesInTransaction(t *testing.T) {
	for _, tc := range []struct {
		name         string
		privacy      *db.UserPrivacy
		wantAuto     bool
		wantState    string
		wantTrust    bool
		wantDMOpened bool
	}{
		{"no_saved_settings", nil, false, "pending", false, false},
		{"requests_on", &db.UserPrivacy{AllowMemberDMs: true, MessageRequests: true}, false, "pending", false, false},
		{"requests_off", &db.UserPrivacy{AllowMemberDMs: true, MessageRequests: false}, true, "accepted", true, true},
		{"dms_off_never_auto_accepts", &db.UserPrivacy{AllowMemberDMs: false, MessageRequests: false}, false, "pending", false, false},
		{"dms_off_requests_on", &db.UserPrivacy{AllowMemberDMs: false, MessageRequests: true}, false, "pending", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			database := openMigratedMemory(t)
			ctx := context.Background()
			sender, recipient, channelID, msgID := seedMessageRequestPair(t, database, "auto-sender", "auto-recipient")
			// GetOrCreateDMChannel opens the DM for both sides; a first send
			// meets a recipient whose side is not open.
			if err := database.CloseDM(ctx, recipient, channelID); err != nil {
				t.Fatalf("CloseDM: %v", err)
			}
			if tc.privacy != nil {
				if err := database.SetUserPrivacy(ctx, recipient, *tc.privacy); err != nil {
					t.Fatalf("SetUserPrivacy: %v", err)
				}
			}

			out, err := database.CreateMessageRequest(ctx, sender, recipient, channelID, msgID)
			if err != nil {
				t.Fatalf("CreateMessageRequest: %v", err)
			}
			if !out.Created || out.AutoAccepted != tc.wantAuto || out.Opened != tc.wantDMOpened {
				t.Errorf("outcome = %+v, want Created, AutoAccepted=%v, Opened=%v", out, tc.wantAuto, tc.wantDMOpened)
			}
			req, err := database.GetMessageRequestByPair(ctx, sender, recipient)
			if err != nil || req.State != tc.wantState {
				t.Fatalf("request = %+v, %v; want state %q", req, err, tc.wantState)
			}
			if (req.DecidedAt != nil) != tc.wantAuto {
				t.Errorf("DecidedAt = %v, want set = %v", req.DecidedAt, tc.wantAuto)
			}
			if trusted, _ := database.IsTrustedSender(ctx, recipient, sender); trusted != tc.wantTrust {
				t.Errorf("recipient trusts sender = %v, want %v", trusted, tc.wantTrust)
			}
			if trusted, _ := database.IsTrustedSender(ctx, sender, recipient); !trusted {
				t.Error("sender does not trust the recipient: the sent_first edge is written either way")
			}
			var open int
			if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM dm_open_state WHERE user_id = ? AND channel_id = ?`, recipient, channelID).Scan(&open); err != nil {
				t.Fatal(err)
			}
			if (open == 1) != tc.wantDMOpened {
				t.Errorf("recipient dm_open_state rows = %d, want open = %v", open, tc.wantDMOpened)
			}
		})
	}
}

// The second call for a pair finds the row. After an auto-accept it still
// reports AutoAccepted (the recipient trusts the sender) but neither Created
// nor Opened; a pending row stays pending and reports nothing to deliver.
func TestCreateMessageRequest_ExistingRowPath(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sender, recipient, channelID, msgID := seedMessageRequestPair(t, database, "auto2-sender", "auto2-recipient")
	if err := database.CloseDM(ctx, recipient, channelID); err != nil {
		t.Fatal(err)
	}
	if err := database.SetUserPrivacy(ctx, recipient, db.UserPrivacy{AllowMemberDMs: true, MessageRequests: false}); err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateMessageRequest(ctx, sender, recipient, channelID, msgID); err != nil {
		t.Fatal(err)
	}
	out, err := database.CreateMessageRequest(ctx, sender, recipient, channelID, msgID)
	if err != nil || out.Created || !out.AutoAccepted || out.Opened {
		t.Errorf("second call = %+v, %v; want only AutoAccepted", out, err)
	}

	// A pending row from before the setting went off stays pending.
	s2, r2, c2, m2 := seedMessageRequestPair(t, database, "auto3-sender", "auto3-recipient")
	if _, err := database.CreateMessageRequest(ctx, s2, r2, c2, m2); err != nil {
		t.Fatal(err)
	}
	if err := database.SetUserPrivacy(ctx, r2, db.UserPrivacy{AllowMemberDMs: true, MessageRequests: false}); err != nil {
		t.Fatal(err)
	}
	out, err = database.CreateMessageRequest(ctx, s2, r2, c2, m2)
	if err != nil || out.Created || out.AutoAccepted {
		t.Errorf("resend over a pending row = %+v, %v; want nothing delivered", out, err)
	}
	if req, err := database.GetMessageRequestByPair(ctx, s2, r2); err != nil || req.State != "pending" {
		t.Errorf("request = %+v, %v; want still pending", req, err)
	}
}
