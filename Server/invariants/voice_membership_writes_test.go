package invariants

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"testing"
)

// Voice membership has one writer: the registry. The fixtures cover each
// spelling of a write, the registry's own exemption, and what is not a write;
// the last case runs the rule over the real tree.
func TestVoiceMembershipWritesOnlyInRegistry(t *testing.T) {
	tests := []struct {
		name string
		path string
		src  string
		want int
	}{
		{
			name: "a row insert through the hub's store is flagged",
			path: "ws/voice_join.go",
			src:  "package ws\nfunc f(h *Hub) { _ = h.voice.Join(nil, 1, 2, 0) }\n",
			want: 1,
		},
		{
			name: "a row delete is flagged, even through a longer selector chain",
			path: "ws/hub_sweep.go",
			src:  "package ws\nfunc f(t *T) { _, _ = t.h.voice.LeaveIfMatch(nil, 1, 2, \"j\") }\n",
			want: 1,
		},
		{
			name: "a local alias of the store is flagged too",
			path: "ws/hub_sweep.go",
			src:  "package ws\nfunc f(voice Store) { _, _ = voice.LeaveIfMatch(nil, 1, 2, \"j\") }\n",
			want: 1,
		},
		{
			name: "a slot field assignment is flagged",
			path: "ws/livekit_webhook.go",
			src:  "package ws\nfunc f(c *Client) { c.voiceChID = 0 }\n",
			want: 1,
		},
		{
			name: "the completed flag and the E2EE key are slot fields",
			path: "ws/voice_reconcile.go",
			src:  "package ws\nfunc f(c *Client) { c.voiceJoinCompleted = false; c.e2ee = e2eeAnnounce{} }\n",
			want: 2,
		},
		{
			name: "a promoted-through-embedding write is the same field",
			path: "ws/client.go",
			src:  "package ws\nfunc f(c *Client) { c.voiceSlot.pendingModServerMuted = true }\n",
			want: 1,
		},
		{
			name: "an increment of a slot field is flagged",
			path: "ws/client.go",
			src:  "package ws\nfunc f(c *Client) { c.voiceChID++ }\n",
			want: 1,
		},
		{
			name: "the registry files own the writes",
			path: "ws/voice_registry_txn.go",
			src:  "package ws\nfunc f(t *T, c *Client) { _, _ = t.h.voice.LeaveIfMatch(nil, 1, 2, \"j\"); c.voiceChID = 0 }\n",
			want: 0,
		},
		{
			name: "reads of a slot field are not writes",
			path: "ws/voice_e2ee.go",
			src:  "package ws\nfunc f(c *Client) int64 { x := c.voiceChID; return x }\n",
			want: 0,
		},
		{
			name: "a local variable named like a slot field is not a selector write",
			path: "ws/voice_grace.go",
			src:  "package ws\nfunc f() { e2ee := 1; _ = e2ee }\n",
			want: 0,
		},
		{
			name: "reading the voice state is not a membership write",
			path: "ws/handlers.go",
			src:  "package ws\nfunc f(h *Hub) { _, _ = h.voice.State(nil, 1) }\n",
			want: 0,
		},
		{
			name: "Join on something that is not the voice store is not ours",
			path: "ws/pubsub.go",
			src:  "package ws\nfunc f(g *group) { g.Join(1) }\n",
			want: 0,
		},
		{
			name: "outside ws the rule does not apply",
			path: "service/voice.go",
			src:  "package service\nfunc f(s *S) { _, _ = s.voice.LeaveIfMatch(nil, 1, 2, \"j\") }\n",
			want: 0,
		},
		{
			name: "a delegator call outside the registry is flagged",
			path: "ws/livekit_webhook.go",
			src:  "package ws\nfunc f(c *Client) { c.clearVoiceState(); c.setVoiceState(1, \"t\") }\n",
			want: 2,
		},
		{
			name: "a slot mutator call outside the registry is flagged",
			path: "ws/livekit_webhook.go",
			src:  "package ws\nfunc f(c *Client) { c.clearExact(1, \"t\"); c.setE2EE(e2eeAnnounce{}) }\n",
			want: 2,
		},
		{
			name: "the handle's own clearExact is not a slot call",
			path: "ws/livekit_webhook.go",
			src:  "package ws\nfunc f(txn *voiceTxn, c *Client) { txn.clearExact(c, 1, \"t\") }\n",
			want: 0,
		},
		{
			name: "heldTxn outside the allow list is flagged",
			path: "ws/hub_sweep.go",
			src:  "package ws\nfunc f(h *Hub) { _ = h.heldTxn(1) }\n",
			want: 1,
		},
		{
			name: "an allow-listed site at its exact count is clean",
			path: "ws/voice_leave.go",
			src:  "package ws\nfunc f(h *Hub) { _ = h.heldTxn(1); _ = h.heldTxn(1); _ = h.heldTxn(1) }\n",
			want: 0,
		},
		{
			name: "one call more than the allow-list row is flagged",
			path: "ws/voice_leave.go",
			src:  "package ws\nfunc f(h *Hub) { _ = h.heldTxn(1); _ = h.heldTxn(1); _ = h.heldTxn(1); _ = h.heldTxn(1) }\n",
			want: 1,
		},
		{
			name: "the allow comment must name the rule",
			path: "ws/hub_sweep.go",
			src:  "package ws\nfunc f(h *Hub) { _ = h.voice.Join(nil, 1, 2, 0) } //invariant:allow voice-membership-writes — probe\n",
			want: 0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fset := token.NewFileSet()
			got := checkSourceWith([]Rule{voiceMembershipWrites}, fset, tt.path, []byte(tt.src))
			if len(got) != tt.want {
				t.Fatalf("want %d violation(s), got %d: %v", tt.want, len(got), got)
			}
			for _, v := range got {
				if v.Rule != voiceMembershipWritesID {
					t.Errorf("violation carries rule %q, want %q", v.Rule, voiceMembershipWritesID)
				}
			}
		})
	}

	t.Run("every allow-list file exists", func(t *testing.T) {
		for rel := range VoiceMutatorAllow {
			if _, err := os.Stat(filepath.Join("..", filepath.FromSlash(rel))); err != nil {
				t.Errorf("VoiceMutatorAllow lists %s, which does not exist: %v", rel, err)
			}
		}
	})

	t.Run("the real tree has no stray writer", func(t *testing.T) {
		violations, err := runWith([]Rule{voiceMembershipWrites}, "..")
		if err != nil {
			t.Fatalf("walking the server tree: %v", err)
		}
		for _, v := range violations {
			t.Errorf("%s", v)
		}
	})
}

// A row that lists more calls than its file makes (or a file that is gone) is
// stale: the inventory only shrinks.
func TestVoiceMutatorAllowIsLive(t *testing.T) {
	for rel, rows := range VoiceMutatorAllow {
		f, err := parser.ParseFile(token.NewFileSet(), filepath.Join("..", filepath.FromSlash(rel)), nil, 0)
		if err != nil {
			t.Errorf("VoiceMutatorAllow lists %s, which does not parse: %v", rel, err)
			continue
		}
		calls := voiceMutatorCalls(f)
		for name, n := range rows {
			if got := len(calls[name]); got != n {
				t.Errorf("VoiceMutatorAllow lists %s .%s x%d but the file calls it %d time(s); fix or delete the row", rel, name, n, got)
			}
		}
	}
}
