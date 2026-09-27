package ws

// SRE-M2 server half: the "voice join" line carries the joining frame's req_id
// and every leave path records why it ran. These lock those two log fields in
// place.
//
// The static guard is the one that matters most: a new caller that forgets its
// reason argument still compiles (the parameter is a string) and still tears
// the session down, so only a source scan catches the missing field before it
// reaches an operator's logs.

import (
	"bytes"
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
)

// lockedBuffer is a slog sink safe against the background goroutines a leave
// can spawn (the DB-retry loop logs concurrently with the handler).
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureVoiceLog redirects the default logger into a locked buffer for the
// duration of one test.
func captureVoiceLog(t *testing.T) *lockedBuffer {
	t.Helper()
	buf := &lockedBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

// TestHandleVoiceLeave_LogsEveryReason drives handleVoiceLeave once per
// supported reason and asserts each one reaches the "voice leave" line. A
// caller that dropped its reason argument would compile but log `reason=""`,
// which this catches.
func TestHandleVoiceLeave_LogsEveryReason(t *testing.T) {
	reasons := []string{
		voiceLeaveReasonClient,
		voiceLeaveReasonSwitch,
		voiceLeaveReasonDisconnect,
		voiceLeaveReasonHandshake,
		voiceLeaveReasonModerator,
		voiceLeaveReasonTokenRefresh,
		voiceLeaveReasonRevoked,
	}
	for _, reason := range reasons {
		t.Run(reason, func(t *testing.T) {
			ctx := context.Background()
			database := newHarvestVoiceDB(t)
			uid := seedHarvestVoiceUser(t, database, "leave-reason")
			chID := mustCreateVoiceChannel(t, database, "voice-lr")
			if err := database.JoinVoiceChannel(ctx, uid, chID); err != nil {
				t.Fatalf("JoinVoiceChannel: %v", err)
			}
			vs, err := database.GetVoiceState(ctx, uid)
			if err != nil || vs == nil {
				t.Fatalf("GetVoiceState: %v", err)
			}

			h := newTestHub(t, database, auth.NewRateLimiter(), nil)
			t.Cleanup(h.Stop)
			c := NewTestClient(h, uid, make(chan []byte, 16))
			h.clients[uid] = c
			c.setVoiceState(chID, vs.JoinedAt)

			buf := captureVoiceLog(t)
			h.handleVoiceLeave(ctx, c, reason)

			if got := buf.String(); !strings.Contains(got, "reason="+reason) {
				t.Fatalf("leave log missing reason %q:\n%s", reason, got)
			}
		})
	}
}

// TestHandleVoiceJoin_LogsReqID asserts the join line carries the request id
// the joining frame supplied, so an operator can correlate a token with its
// arrival.
func TestHandleVoiceJoin_LogsReqID(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "join-reqid")
	chID := mustCreateVoiceChannel(t, database, "voice-jr")

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	t.Cleanup(h.Stop)
	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "reqid-key",
		LiveKitAPISecret: "reqid-secret-0123456789abcdef",
		LiveKitURL:       "ws://127.0.0.1:9",
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	h.livekit = lk

	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	c := NewTestClient(h, uid, make(chan []byte, 64))
	c.user = user
	h.clients[uid] = c

	const reqID = "req-join-abc123"
	payload, _ := json.Marshal(map[string]any{"channel_id": chID})

	buf := captureVoiceLog(t)
	h.handleVoiceJoin(ctx, c, json.RawMessage(payload), reqID)

	if got := c.getVoiceChID(); got != chID {
		t.Fatalf("join did not land: voice channel = %d, want %d (log:\n%s)", got, chID, buf.String())
	}
	if got := buf.String(); !strings.Contains(got, "req_id="+reqID) {
		t.Fatalf("join log missing req_id %q:\n%s", reqID, got)
	}
}

// TestVoiceLeaveCallersPassReason scans every non-test file in the package for
// calls to the two leave entry points and fails on any call whose final
// argument is not a voiceLeaveReason* constant — including the empty string,
// which is what a dropped argument compiles to.
//
// A syntactic scan rather than running each caller: the point is to catch a
// future caller that forgets the argument, which no runtime assertion can see
// because the call still succeeds.
//
// Two call sites (handlers.go) forward a Result's LeaveVoiceReason rather than
// naming a constant, so the scan also checks that every Result literal setting
// LeaveVoice: true also sets LeaveVoiceReason.
func TestVoiceLeaveCallersPassReason(t *testing.T) {
	const pkgDir = "."

	fset := token.NewFileSet()
	entries, err := os.ReadDir(pkgDir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}

	// The set of constant identifiers a caller may legitimately pass.
	reasonConsts := map[string]bool{
		"voiceLeaveReasonClient":       true,
		"voiceLeaveReasonSwitch":       true,
		"voiceLeaveReasonDisconnect":   true,
		"voiceLeaveReasonHandshake":    true,
		"voiceLeaveReasonModerator":    true,
		"voiceLeaveReasonTokenRefresh": true,
		"voiceLeaveReasonRevoked":      true,
	}
	targets := map[string]bool{
		"handleVoiceLeave":          true,
		"handleVoiceLeaveIfStillIn": true,
	}

	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		p := filepath.Join(pkgDir, name)
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			t.Fatalf("ParseFile %s: %v", p, err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.CallExpr:
				sel, ok := n.Fun.(*ast.SelectorExpr)
				if !ok || !targets[sel.Sel.Name] {
					return true
				}
				if len(n.Args) == 0 {
					t.Errorf("%s:%d: %s call has no reason argument", name, fset.Position(n.Pos()).Line, sel.Sel.Name)
					return true
				}
				if !isReasonExpr(n.Args[len(n.Args)-1], reasonConsts) {
					t.Errorf("%s:%d: %s final argument is not a voiceLeaveReason* constant and not a forwarded LeaveVoiceReason",
						name, fset.Position(n.Pos()).Line, sel.Sel.Name)
				}
			case *ast.CompositeLit:
				if !setsLeaveVoiceTrue(n) {
					return true
				}
				if !hasField(n, "LeaveVoiceReason") {
					t.Errorf("%s:%d: Result sets LeaveVoice: true without LeaveVoiceReason; the leave would log an empty reason",
						name, fset.Position(n.Pos()).Line)
				}
			}
			return true
		})
	}
}

// isReasonExpr reports whether e is a voiceLeaveReason* constant or the
// forwarded Result field LeaveVoiceReason.
func isReasonExpr(e ast.Expr, reasonConsts map[string]bool) bool {
	switch e := e.(type) {
	case *ast.Ident:
		return reasonConsts[e.Name]
	case *ast.SelectorExpr:
		return e.Sel.Name == "LeaveVoiceReason"
	default:
		return false
	}
}

// setsLeaveVoiceTrue reports whether a composite literal sets LeaveVoice to
// the identifier true.
func setsLeaveVoiceTrue(lit *ast.CompositeLit) bool {
	for _, elt := range lit.Elts {
		kv, ok := elt.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		key, ok := kv.Key.(*ast.Ident)
		if !ok || key.Name != "LeaveVoice" {
			continue
		}
		val, ok := kv.Value.(*ast.Ident)
		return ok && val.Name == "true"
	}
	return false
}

// hasField reports whether a composite literal has a key with the given name.
func hasField(lit *ast.CompositeLit, field string) bool {
	for _, elt := range lit.Elts {
		kv, ok := elt.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		if key, ok := kv.Key.(*ast.Ident); ok && key.Name == field {
			return true
		}
	}
	return false
}
