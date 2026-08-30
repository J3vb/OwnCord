package ws_test

import (
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// BenchmarkReconnectStorm is hub_sim_test.go's reconnect-transfer step over 50
// live clients: one op resumes every client once, each resume preceded by a
// global broadcast so its 8-frame replay is real and the registration races
// nothing but the seqMu it takes. Item 6 collects the baseline; run with
//
//	go test -run '^$' -bench ReconnectStorm -benchmem ./ws/
func BenchmarkReconnectStorm(b *testing.B) {
	hub, database := newTestHub(b)
	const n = 50
	payload := []byte(`{"type":"sim","bench":true}`)
	newConn := func(u *db.User, lastSeq uint64) *ws.Client {
		return ws.NewSimClientForTest(hub, u, 0, lastSeq, make(chan []byte, 256), make(chan []byte, 64), make(chan []byte, 64))
	}
	users := make([]*db.User, n)
	conns := make([]*ws.Client, n)
	for i := range n {
		users[i] = seedOwnerUser(b, database, fmt.Sprintf("storm-%d", i))
		conns[i] = newConn(users[i], 0)
		hub.RegisterNowForTest(conns[i])
	}
	for range 16 { // so every watermark below sits inside the ring
		hub.DeliverBroadcastForTest(0, nil, payload)
	}
	allowed := map[int64]bool{}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		for i := range n {
			seq := hub.DeliverBroadcastForTest(0, nil, payload)
			nc := newConn(users[i], seq-8)
			if _, ok := hub.ReconnectRegisterForTest(nc, seq-8, allowed); !ok {
				b.Fatalf("resume from %d refused a replay", seq-8)
			}
			hub.UnregisterNowForTest(conns[i])
			conns[i] = nc
		}
	}
}
