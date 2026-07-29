package auth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// fakeStore is a hand-rolled tokenStore so the security-critical resolution
// logic is tested without a real database. It satisfies the (unexported)
// tokenStore interface structurally when passed to auth.ResolveTokenHash.
type fakeStore struct {
	sess    *db.Session
	sessErr error
	apiTok  *db.APIToken
	apiErr  error
	user    *db.User
	userErr error
	role    *db.Role
	roleErr error

	apiCalled bool // set when the API-token fallback is consulted
}

func (f *fakeStore) GetSessionByTokenHash(_ context.Context, _ string) (*db.Session, error) {
	return f.sess, f.sessErr
}

func (f *fakeStore) GetActiveAPIToken(_ context.Context, _ string) (*db.APIToken, error) {
	f.apiCalled = true
	return f.apiTok, f.apiErr
}

func (f *fakeStore) GetUserByID(_ context.Context, _ int64) (*db.User, error) {
	return f.user, f.userErr
}

func (f *fakeStore) GetRoleByID(_ context.Context, _ int64) (*db.Role, error) {
	return f.role, f.roleErr
}

func future() string { return time.Now().Add(time.Hour).UTC().Format("2006-01-02T15:04:05Z") }
func past() string   { return time.Now().Add(-time.Hour).UTC().Format("2006-01-02T15:04:05Z") }

func TestResolveTokenHash(t *testing.T) {
	dbErr := errors.New("db down")
	user := &db.User{ID: 7, RoleID: 3}
	role := &db.Role{ID: 3}

	tests := []struct {
		name           string
		store          *fakeStore
		wantErr        error // nil = success; dbErr = wrapped (non-sentinel) DB error; else a sentinel
		wantUser       bool
		wantSessionNil bool // only checked on success
		wantAPICalled  bool
	}{
		{
			name:     "valid session resolves without consulting api tokens",
			store:    &fakeStore{sess: &db.Session{UserID: 7, ExpiresAt: future()}, user: user, role: role},
			wantErr:  nil,
			wantUser: true,
		},
		{
			name:    "expired session returns ErrTokenExpired",
			store:   &fakeStore{sess: &db.Session{UserID: 7, ExpiresAt: past()}},
			wantErr: auth.ErrTokenExpired,
		},
		{
			name:           "session miss falls through to active api token",
			store:          &fakeStore{sess: nil, apiTok: &db.APIToken{UserID: 7}, user: user, role: role},
			wantErr:        nil,
			wantUser:       true,
			wantSessionNil: true,
			wantAPICalled:  true,
		},
		{
			name:          "no session and no active api token is ErrTokenNotFound",
			store:         &fakeStore{sess: nil, apiTok: nil},
			wantErr:       auth.ErrTokenNotFound,
			wantAPICalled: true,
		},
		{
			name:          "api-token user missing is ErrUserNotFound",
			store:         &fakeStore{sess: nil, apiTok: &db.APIToken{UserID: 7}, user: nil},
			wantErr:       auth.ErrUserNotFound,
			wantAPICalled: true,
		},
		{
			name:    "missing role is ErrRoleNotFound",
			store:   &fakeStore{sess: &db.Session{UserID: 7, ExpiresAt: future()}, user: user, role: nil},
			wantErr: auth.ErrRoleNotFound,
		},
		{
			name:    "db error on session lookup does not fall through to api tokens",
			store:   &fakeStore{sessErr: dbErr},
			wantErr: dbErr,
			// wantAPICalled stays false: an outage must never be treated as a session miss.
		},
		{
			name:          "db error on api-token lookup is surfaced, not swallowed",
			store:         &fakeStore{sess: nil, apiErr: dbErr},
			wantErr:       dbErr,
			wantAPICalled: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			u, gotRole, sess, err := auth.ResolveTokenHash(context.Background(), tc.store, "hash")

			switch {
			case tc.wantErr == nil:
				if err != nil {
					t.Fatalf("want success, got error %v", err)
				}
				if gotRole == nil {
					t.Fatal("want role on success, got nil")
				}
				if tc.wantSessionNil && sess != nil {
					t.Fatalf("want nil session for api-token principal, got %+v", sess)
				}
				if !tc.wantSessionNil && sess == nil {
					t.Fatal("want session for session principal, got nil")
				}
			case errors.Is(tc.wantErr, dbErr):
				if !errors.Is(err, dbErr) {
					t.Fatalf("want wrapped db error, got %v", err)
				}
				// A DB outage must never masquerade as a sentinel outcome.
				for _, s := range []error{auth.ErrTokenNotFound, auth.ErrTokenExpired, auth.ErrUserNotFound, auth.ErrRoleNotFound} {
					if errors.Is(err, s) {
						t.Fatalf("db error must not be sentinel %v", s)
					}
				}
			default:
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("want %v, got %v", tc.wantErr, err)
				}
			}

			if errors.Is(err, auth.ErrTokenExpired) && sess == nil {
				t.Fatal("expired session must be returned so the caller can clean it up")
			}
			if tc.wantUser && u == nil {
				t.Fatal("want user, got nil")
			}
			if !tc.wantUser && u != nil {
				t.Fatalf("want nil user, got %+v", u)
			}
			if tc.store.apiCalled != tc.wantAPICalled {
				t.Fatalf("api-token fallback called = %v, want %v", tc.store.apiCalled, tc.wantAPICalled)
			}
		})
	}
}
