package ws_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/ws"
)

// savedFileTypes stands in for the settings rows the admin panel writes.
type savedFileTypes struct {
	mu     sync.Mutex
	policy storage.FileTypePolicy
	err    error
}

func (s *savedFileTypes) FileTypePolicy(context.Context) (storage.FileTypePolicy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.policy, s.err
}

func (s *savedFileTypes) set(p storage.FileTypePolicy, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.policy, s.err = p, err
}

type uploadPolicyLists struct {
	BlockedExtensions []string `json:"blocked_extensions"`
	AllowedExtensions []string `json:"allowed_extensions"`
}

func authOKFileTypes(t *testing.T, hub *ws.Hub, user *db.User) uploadPolicyLists {
	t.Helper()
	var env struct {
		Payload struct {
			UploadPolicy uploadPolicyLists `json:"upload_policy"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(hub.BuildAuthOKForTest(user, "member"), &env); err != nil {
		t.Fatalf("unmarshal auth_ok: %v", err)
	}
	return env.Payload.UploadPolicy
}

func uploadPolicyHub(t *testing.T, saved *savedFileTypes) (*ws.Hub, *db.DB) {
	t.Helper()
	database := openServeTestDB(t)
	hub := newTestHubWith(t, ws.HubOptions{
		DB:              database,
		UploadPolicy:    ws.UploadPolicy{MaxUploadBytes: 10 << 20},
		UploadFileTypes: saved,
	})
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	return hub, database
}

// Both lists saved empty reach a connected client as two empty arrays, never
// absent, and an auth_ok built right after carries them too rather than the
// cached lists from before the save.
func TestBroadcastUploadPolicy_EmptiedListsReachClientsAndAuthOK(t *testing.T) {
	saved := &savedFileTypes{policy: storage.FileTypePolicy{Blocked: []string{"bat", "html"}}}
	hub, database := uploadPolicyHub(t, saved)
	user := seedServeUser(t, database, "policy-member")
	if got := authOKFileTypes(t, hub, user); !slices.Equal(got.BlockedExtensions, []string{"bat", "html"}) {
		t.Fatalf("auth_ok before the save = %+v, want the blocked list", got)
	}

	send := make(chan []byte, 16)
	client := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(client)
	waitRegistered(t, hub, client)

	saved.set(storage.FileTypePolicy{Blocked: []string{}, Allowed: []string{}}, nil)
	hub.BroadcastUploadPolicy()

	msg := drainForMsgType(t, send, "upload_policy")
	raw, err := json.Marshal(msg["payload"])
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	if got := string(raw); got != `{"allowed_extensions":[],"blocked_extensions":[]}` {
		t.Errorf("payload = %s, want both lists as empty arrays", got)
	}
	if got := authOKFileTypes(t, hub, user); len(got.BlockedExtensions) != 0 || len(got.AllowedExtensions) != 0 {
		t.Errorf("auth_ok after the save = %+v, want both lists empty", got)
	}
}

// A policy that cannot be read sends nothing, and auth_ok keeps the lists it
// had: clients must never be told everything is allowed by a failed read.
func TestBroadcastUploadPolicy_FailedReadSendsNothing(t *testing.T) {
	saved := &savedFileTypes{policy: storage.FileTypePolicy{Blocked: []string{"bat"}}}
	hub, database := uploadPolicyHub(t, saved)
	user := seedServeUser(t, database, "policy-failed")
	authOKFileTypes(t, hub, user)

	send := make(chan []byte, 16)
	client := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(client)
	waitRegistered(t, hub, client)

	saved.set(storage.FileTypePolicy{}, errors.New("settings read failed"))
	hub.BroadcastUploadPolicy()
	if got := authOKFileTypes(t, hub, user); !slices.Equal(got.BlockedExtensions, []string{"bat"}) {
		t.Errorf("auth_ok after a failed read = %+v, want the earlier blocked list", got)
	}

	// The next save that reads cleanly is the first upload_policy the
	// client sees, so the failed one queued nothing.
	saved.set(storage.FileTypePolicy{Blocked: []string{"exe"}}, nil)
	hub.BroadcastUploadPolicy()
	raw, err := json.Marshal(drainForMsgType(t, send, "upload_policy")["payload"])
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	if got := string(raw); got != `{"allowed_extensions":[],"blocked_extensions":["exe"]}` {
		t.Errorf("first upload_policy = %s, want the later clean save", got)
	}
}

// upload_policy is a snapshot auth_ok already carries, so it is never
// sequenced: a resume must not replay an older one over the current lists.
func TestBroadcastUploadPolicy_IsNotSequenced(t *testing.T) {
	saved := &savedFileTypes{policy: storage.FileTypePolicy{Blocked: []string{"bat"}}}
	hub, database := uploadPolicyHub(t, saved)
	user := seedServeUser(t, database, "policy-unsequenced")
	send := make(chan []byte, 16)
	client := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(client)
	waitRegistered(t, hub, client)

	hub.BroadcastUploadPolicy()
	if seq, ok := drainForMsgType(t, send, "upload_policy")["seq"]; ok {
		t.Errorf("upload_policy carries seq %v, want none", seq)
	}
}
