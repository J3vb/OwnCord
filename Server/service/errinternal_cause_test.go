package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// faultStore fails exactly the store calls named in fail, each with the
// injected error, and delegates every other call to the real database.
type faultStore struct {
	*db.DB
	fail map[string]error
}

func (f *faultStore) ListPendingMessageRequests(ctx context.Context, id int64) ([]db.MessageRequestView, error) {
	if err := f.fail["ListPendingMessageRequests"]; err != nil {
		return nil, err
	}
	return f.DB.ListPendingMessageRequests(ctx, id)
}

func (f *faultStore) AcceptMessageRequest(ctx context.Context, id, recipientID int64) (*db.MessageRequest, error) {
	if err := f.fail["AcceptMessageRequest"]; err != nil {
		return nil, err
	}
	return f.DB.AcceptMessageRequest(ctx, id, recipientID)
}

func (f *faultStore) TransitionMessageRequest(ctx context.Context, id, recipientID int64, to string) (bool, error) {
	if err := f.fail["TransitionMessageRequest"]; err != nil {
		return false, err
	}
	return f.DB.TransitionMessageRequest(ctx, id, recipientID, to)
}

func (f *faultStore) GetMessageRequest(ctx context.Context, id, recipientID int64) (*db.MessageRequest, error) {
	if err := f.fail["GetMessageRequest"]; err != nil {
		return nil, err
	}
	return f.DB.GetMessageRequest(ctx, id, recipientID)
}

func (f *faultStore) GetRoleForUser(ctx context.Context, userID int64) (*db.Role, error) {
	if err := f.fail["GetRoleForUser"]; err != nil {
		return nil, err
	}
	return f.DB.GetRoleForUser(ctx, userID)
}

func (f *faultStore) AcknowledgeNSFW(ctx context.Context, userID, channelID int64) (bool, error) {
	if err := f.fail["AcknowledgeNSFW"]; err != nil {
		return false, err
	}
	return f.DB.AcknowledgeNSFW(ctx, userID, channelID)
}

func (f *faultStore) RevokeNSFW(ctx context.Context, userID, channelID int64) error {
	if err := f.fail["RevokeNSFW"]; err != nil {
		return err
	}
	return f.DB.RevokeNSFW(ctx, userID, channelID)
}

func (f *faultStore) UpdateUserIdentityKey(ctx context.Context, id int64, key *string) error {
	if err := f.fail["UpdateUserIdentityKey"]; err != nil {
		return err
	}
	return f.DB.UpdateUserIdentityKey(ctx, id, key)
}

func (f *faultStore) GetUserByID(ctx context.Context, id int64) (*db.User, error) {
	if err := f.fail["GetUserByID"]; err != nil {
		return nil, err
	}
	return f.DB.GetUserByID(ctx, id)
}

func (f *faultStore) GetRecoveryKit(ctx context.Context, userID int64) (*db.RecoveryKit, error) {
	if err := f.fail["GetRecoveryKit"]; err != nil {
		return nil, err
	}
	return f.DB.GetRecoveryKit(ctx, userID)
}

// A store failure reported as ErrInternal must keep the store error on the
// chain: the REST handler logs ErrInternal causes, so a dropped %w is a lost
// log line.
func TestErrInternal_KeepsStoreCause(t *testing.T) {
	cause := errors.New("database is locked")

	cases := []struct {
		name string
		// fail is the store call that returns cause.
		fail string
		// run seeds what it needs on the faulting store and returns the error.
		run func(t *testing.T, ctx context.Context, st *faultStore) error
	}{
		{"message_request_list", "ListPendingMessageRequests", func(t *testing.T, ctx context.Context, st *faultStore) error {
			_, err := NewMessageRequestService(st, NewBlockService(st)).ListPending(ctx, 2)
			return err
		}},
		{"message_request_accept", "AcceptMessageRequest", func(t *testing.T, ctx context.Context, st *faultStore) error {
			_, err := NewMessageRequestService(st, NewBlockService(st)).Accept(ctx, 2, 1)
			return err
		}},
		{"message_request_transition", "TransitionMessageRequest", func(t *testing.T, ctx context.Context, st *faultStore) error {
			_, err := NewMessageRequestService(st, NewBlockService(st)).Ignore(ctx, 2, 1)
			return err
		}},
		{"message_request_reload", "GetMessageRequest", func(t *testing.T, ctx context.Context, st *faultStore) error {
			_, err := NewMessageRequestService(st, NewBlockService(st)).Ignore(ctx, 2, 1)
			return err
		}},
		{"nsfw_visibility", "GetRoleForUser", func(t *testing.T, ctx context.Context, st *faultStore) error {
			return newFaultNSFW(t, st).Acknowledge(ctx, 1, 10)
		}},
		{"nsfw_acknowledge", "AcknowledgeNSFW", func(t *testing.T, ctx context.Context, st *faultStore) error {
			return newFaultNSFW(t, st).Acknowledge(ctx, 1, 10)
		}},
		{"nsfw_revoke", "RevokeNSFW", func(t *testing.T, ctx context.Context, st *faultStore) error {
			return newFaultNSFW(t, st).Revoke(ctx, 1, 10)
		}},
		{"user_identity_key_update", "UpdateUserIdentityKey", func(t *testing.T, ctx context.Context, st *faultStore) error {
			_, err := NewUserService(st).UpdateIdentityKey(ctx, 1, "key")
			return err
		}},
		{"user_identity_key_reload", "GetUserByID", func(t *testing.T, ctx context.Context, st *faultStore) error {
			_, err := NewUserService(st).UpdateIdentityKey(ctx, 1, "key")
			return err
		}},
		{"recovery_kit_status", "GetRecoveryKit", func(t *testing.T, ctx context.Context, st *faultStore) error {
			svc := NewAuthService(st, auth.NewRateLimiter(), make([]byte, 32), nil)
			_, err := svc.RecoveryKitStatus(ctx, Principal{User: &db.User{ID: 1}})
			return err
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			database := newTestDB(t)
			seedRole(t, database, &db.Role{ID: permissions.MemberRoleID, Name: "member",
				Permissions: permissions.SendMessages | permissions.ReadMessages, Position: 1})
			seedUser(t, database, &db.User{ID: 1, Username: "alice", PasswordHash: "h"})
			seedUser(t, database, &db.User{ID: 2, Username: "bob", PasswordHash: "h"})
			seedUserRole(t, database, 1, permissions.MemberRoleID)
			seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})
			labelChannel(t, database, 10, true)
			if _, err := database.ExecContext(ctx, `INSERT INTO message_requests
				(id, sender_id, recipient_id, channel_id, state) VALUES (1, 1, 2, 10, 'pending')`); err != nil {
				t.Fatalf("seed message request: %v", err)
			}

			st := &faultStore{DB: database, fail: map[string]error{tc.fail: cause}}
			err := tc.run(t, ctx, st)
			if !errors.Is(err, ErrInternal) {
				t.Fatalf("err = %v, want ErrInternal", err)
			}
			if !errors.Is(err, cause) {
				t.Fatalf("err = %v, want the store error on the chain", err)
			}
		})
	}
}

func newFaultNSFW(t *testing.T, st *faultStore) *NSFWService {
	t.Helper()
	return NewNSFWService(st, NewPermissionService(st, permissions.NewChecker(st.DB)))
}
