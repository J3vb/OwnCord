package ws_test

// protocol_epoch_test.go — the auth handshake's epoch check (B2-2).
//
// The server accepts an auth frame whose `epoch` lies in
// [minClientEpoch, ProtocolEpoch]; absent means 0, which this first epoch
// still accepts so v1.2.0-alpha.4 clients (no epoch at all) keep connecting.
// Anything else gets one auth_error carrying code
// "protocol_epoch_unsupported" plus the numbers a client needs to say which
// side is out of date, and then the same 1008 close every other handshake
// failure gets. Reuses the epoch-1 rig so the table drives a real socket.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/ws"
)

func TestAuth_ProtocolEpoch(t *testing.T) {
	cases := []struct {
		name   string
		epoch  any // nil = field absent
		accept bool
		older  bool // on reject: is the client the older side?
	}{
		{name: "absent", epoch: nil, accept: true},
		{name: "zero", epoch: 0, accept: true},
		{name: "current", epoch: ws.ProtocolEpoch, accept: true},
		{name: "newer", epoch: ws.ProtocolEpoch + 1, accept: false, older: false},
		{name: "negative", epoch: -1, accept: false, older: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newEpochRig(t, "protocol-epoch-"+tc.name)
			_, tok := r.seedUser(t, "alice")
			c := r.dial(t, "alice")

			payload := map[string]any{"token": tok, "last_seq": 0}
			if tc.epoch != nil {
				payload["epoch"] = tc.epoch
			}
			c.send(map[string]any{"type": "auth", "payload": payload})

			if tc.accept {
				c.expect("auth_ok")
				return
			}

			frame := c.expect("auth_error")
			p, _ := frame["payload"].(map[string]any)
			if got := p["code"]; got != "protocol_epoch_unsupported" {
				t.Fatalf("code = %v, want protocol_epoch_unsupported: %v", got, p)
			}
			if got := p["server_epoch"]; got != json.Number("1") {
				t.Fatalf("server_epoch = %v (%T), want 1", got, got)
			}
			if got := p["min_epoch"]; got != json.Number("0") {
				t.Fatalf("min_epoch = %v, want 0", got)
			}
			msg, _ := p["message"].(string)
			want := "update the server"
			if tc.older {
				want = "update the client"
			}
			if !strings.Contains(msg, want) {
				t.Fatalf("message = %q, want it to say %q", msg, want)
			}
			c.expectClosed()
		})
	}
}
