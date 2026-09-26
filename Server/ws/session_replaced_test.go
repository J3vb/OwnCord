package ws

// session_replaced_test.go — B7-14: when a second device signs in to the
// same account the hub displaces the first connection. It must name the
// reason with a SESSION_REPLACED error frame before the close; a bare 1000
// close is indistinguishable from a network drop, so the displaced client
// reconnected at its 1 s floor and the two devices traded the socket forever.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
)

// sessionReplacedFixture seeds one user with one session and serves the hub.
func sessionReplacedFixture(t *testing.T) (*Hub, int64, string, string) {
	t.Helper()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "two-devices")
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	t.Cleanup(hub.Stop)
	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	t.Cleanup(srv.Close)
	return hub, uid, token, srv.URL
}

// connectDevice authenticates a fresh connection and waits until the hub
// has registered it as the user's live client.
func connectDevice(t *testing.T, ctx context.Context, hub *Hub, uid int64, srvURL, token string) *websocket.Conn {
	t.Helper()
	hub.mu.Lock()
	prev := hub.clients[uid]
	hub.mu.Unlock()
	conn := dialAndAuth(t, ctx, srvURL, token, 0, 0)
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	if typ, _ := readFrameType(t, ctx, conn); typ != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok, got %v", typ)
	}
	if typ, _ := readFrameType(t, ctx, conn); typ != MsgTypeReady {
		t.Fatalf("expected ready, got %v", typ)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		hub.mu.Lock()
		c := hub.clients[uid]
		hub.mu.Unlock()
		if c != nil && c != prev {
			return conn
		}
		if time.Now().After(deadline) {
			t.Fatal("connection never became the registered client")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// readUntilReplaced reads the displaced connection to its end and returns
// whether a SESSION_REPLACED error arrived before the close.
func readUntilReplaced(t *testing.T, ctx context.Context, conn *websocket.Conn) bool {
	t.Helper()
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	sawReplaced := false
	for {
		_, msg, err := conn.Read(readCtx)
		if err != nil {
			if _, ok := errors.AsType[websocket.CloseError](err); !ok {
				t.Fatalf("displaced connection ended without a close frame: %v", err)
			}
			return sawReplaced
		}
		var frame struct {
			Type    string `json:"type"`
			Payload struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg, &frame); err != nil {
			t.Fatalf("unmarshal frame %q: %v", msg, err)
		}
		if frame.Type == MsgTypeError && frame.Payload.Code == ErrCodeSessionReplaced {
			if frame.Payload.Message != "signed in on another device" {
				t.Errorf("SESSION_REPLACED message = %q", frame.Payload.Message)
			}
			sawReplaced = true
		}
	}
}

func TestRegister_SecondDevice_SendsSessionReplacedBeforeClose(t *testing.T) {
	hub, uid, token, srvURL := sessionReplacedFixture(t)
	ctx := context.Background()

	connA := connectDevice(t, ctx, hub, uid, srvURL, token)
	connectDevice(t, ctx, hub, uid, srvURL, token)

	if !readUntilReplaced(t, ctx, connA) {
		t.Fatal("displaced connection was closed without a SESSION_REPLACED frame")
	}
}

// The kick is symmetric: whichever device connects last wins and the other
// is told why, every round. This is the fight the client stops on.
func TestRegister_AlternatingDevices_EachDisplacedOneIsTold(t *testing.T) {
	hub, uid, token, srvURL := sessionReplacedFixture(t)
	ctx := context.Background()

	live := connectDevice(t, ctx, hub, uid, srvURL, token)
	for round := range 4 {
		next := connectDevice(t, ctx, hub, uid, srvURL, token)
		if !readUntilReplaced(t, ctx, live) {
			t.Fatalf("round %d: displaced connection got no SESSION_REPLACED frame", round)
		}
		live = next
	}
}
