package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

type operationalStore struct {
	service.Store
	timeoutReads atomic.Int64
}

func (s *operationalStore) HasActiveTimeout(ctx context.Context, uid int64) (bool, error) {
	s.timeoutReads.Add(1)
	return s.Store.HasActiveTimeout(ctx, uid)
}

func operationalHub(b testing.TB) (*Hub, *db.DB, *operationalStore, []*Client, int64) {
	b.Helper()
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	b.Cleanup(func() { slog.SetDefault(old) })
	database, err := db.OpenWithMaxReaders(filepath.Join(b.TempDir(), "operational.db"), 4)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		b.Fatal(err)
	}
	ctx := context.Background()
	ch, err := database.CreateChannel(ctx, "chat", "text", "", "", 0)
	if err != nil {
		b.Fatal(err)
	}
	store := &operationalStore{Store: database}
	limiter := auth.NewRateLimiter()
	svc := service.New(store, limiter)
	h := newTestHub(b, database, limiter, svc)
	clients := make([]*Client, 100)
	for i := range clients {
		uid, err := database.CreateUser(ctx, fmt.Sprintf("op-%d", i), "unused", 4)
		if err != nil {
			b.Fatal(err)
		}
		u, err := database.GetUserByID(ctx, uid)
		if err != nil {
			b.Fatal(err)
		}
		c := newClient(h, nil, u, "", 0, ctx)
		c.channelID = ch
		h.registerNow(c, nil)
		clients[i] = c
	}
	// Populate the normal permission cache before measuring the hot path.
	if got := len(h.channelReadAudience(ctx, ch)); got != len(clients) {
		b.Fatalf("audience: %d", got)
	}
	store.timeoutReads.Store(0)
	return h, database, store, clients, ch
}

// Run on two CPUs with CPU, block and mutex profiles. Unlike the older
// owner-only fan-out benchmark, this uses real member permissions and a
// file-backed database with the production four-reader minimum.
func BenchmarkOperationalAudience(b *testing.B) {
	h, _, store, _, ch := operationalHub(b)
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if got := len(h.voiceEventAudience(ctx, ch, 1)); got != 100 {
			b.Fatalf("audience: %d", got)
		}
	}
	b.StopTimer()
	b.ReportMetric(float64(store.timeoutReads.Load())/float64(b.N), "timeout-reads/op")
}

// BenchmarkOperationalBurst isolates a synchronized workload burst:
// 100 senders share one channel; 25 voice audiences emit leave/join pairs while
// upload quota/metadata writes use the same database. There is no TLS, SFU,
// reconnect handshake, HTTP parsing, file bytes, or wire transport here;
// these are queue-delivery measurements, NOT docs/capacity.md qualification
// numbers. The two-second spacing keeps
// the unchanged topic and per-user rate limits below their ceilings.
func BenchmarkOperationalBurst(b *testing.B) {
	for _, mixed := range []bool{false, true} {
		name := "chat"
		if mixed {
			name = "mixed"
		}
		b.Run(name, func(b *testing.B) {
			h, database, store, clients, ch := operationalHub(b)
			ctx := context.Background()
			voiceID, err := database.CreateChannel(ctx, "voice", "voice", "", "", 1)
			if err != nil {
				b.Fatal(err)
			}
			uploads := service.NewUploadService(store, h.perms)
			uploads.SetStorageLimits(service.StorageLimits{UserQuotaBytes: 1024 * 1024})
			persister := NewEventPersister(database, 1024, 50, 100*time.Millisecond)
			persister.Start(ctx)
			defer persister.Stop(ctx)
			h.SetEventPersister(persister)
			runDone := make(chan struct{})
			go func() { h.Run(); close(runDone) }()
			defer func() { h.Stop(); <-runDone }()
			var drains sync.WaitGroup
			received := make(chan struct{}, 10100)
			ackSamples := make([][]float64, len(clients))
			deliverySamples := make([][]float64, len(clients))
			stop := make(chan struct{})
			for i, c := range clients {
				drains.Go(func() {
					for {
						select {
						case raw, ok := <-c.send:
							if !ok {
								b.Error("client queue closed")
								return
							}
							var msg struct {
								Type    string `json:"type"`
								ID      string `json:"id"`
								Payload struct {
									Content string `json:"content"`
									UserID  int64  `json:"user_id"`
								} `json:"payload"`
							}
							if err := json.Unmarshal(raw, &msg); err != nil {
								b.Error(err)
								continue
							}
							switch msg.Type {
							case MsgTypeChatSendOK:
								n, _ := strconv.ParseInt(msg.ID, 10, 64)
								ackSamples[i] = append(ackSamples[i], float64(time.Now().UnixNano()-n)/1e6)
								received <- struct{}{}
							case MsgTypeChatMessage:
								n, _ := strconv.ParseInt(msg.Payload.Content, 10, 64)
								if msg.Payload.UserID != c.userID {
									deliverySamples[i] = append(deliverySamples[i], float64(time.Now().UnixNano()-n)/1e6)
								}
								received <- struct{}{}
							case MsgTypeError:
								b.Errorf("unexpected frame: %s", raw)
							}
						case <-stop:
							return
						}
					}
				})
			}
			stopDrains := sync.OnceFunc(func() { close(stop); drains.Wait() })
			defer stopDrains()
			b.ResetTimer()
			for round := range b.N {
				if round > 0 {
					b.StopTimer()
					time.Sleep(2 * time.Second)
					b.StartTimer()
				}

				var workers sync.WaitGroup
				start := make(chan struct{})
				for i, c := range clients {
					workers.Go(func() {
						<-start
						if mixed && i < 25 {
							// The synchronous join fan-out and asynchronous leave
							// use the production audience, sequencing, and queues.
							h.broadcastVoiceEvent(ctx, voiceID, c.userID, buildVoiceLeave(voiceID, c.userID))
							h.sendVoiceEventSync(ctx, voiceID, c.userID, buildVoiceState(db.VoiceState{UserID: c.userID, ChannelID: voiceID}))
						}
						stamp := time.Now().UnixNano()
						h.handleMessage(c, fmt.Appendf(nil, `{"type":"chat_send","id":"%d","payload":{"channel_id":%d,"content":"%d"}}`, stamp, ch, stamp))
					})
					if mixed {
						workers.Go(func() {
							<-start
							res, err := uploads.Reserve(ctx, c.userID, 262144)
							if errors.Is(err, service.ErrQuotaExceeded) {
								return
							}
							if err != nil {
								b.Error(err)
								return
							}
							defer res.Settle(ctx)
							res.Landed()
							if err := uploads.Record(ctx, service.AttachmentRecord{ID: fmt.Sprintf("%d-%d", round, i), UploaderID: c.userID, Filename: "loadtest.bin", MimeType: "application/octet-stream", Size: 262144}, res); err != nil {
								b.Error(err)
							}
						})
					}
				}
				close(start)
				workers.Wait()
				deadline := time.NewTimer(10 * time.Second)
				for range 10100 {
					select {
					case <-received:
					case <-deadline.C:
						b.Fatal("chat acknowledgement/delivery missing (drop or stalled dispatch)")
					}
				}
				deadline.Stop()
			}
			b.StopTimer()
			stopDrains()
			for name, buckets := range map[string][][]float64{"ack": ackSamples, "delivery": deliverySamples} {
				all := make([]float64, 0, len(buckets)*len(buckets[0]))
				for _, bucket := range buckets {
					all = append(all, bucket...)
				}
				slices.Sort(all)
				b.ReportMetric(all[(len(all)-1)*95/100], name+"-p95-ms")
				b.ReportMetric(all[(len(all)-1)*99/100], name+"-p99-ms")
			}
			b.ReportMetric(float64(store.timeoutReads.Load())/float64(b.N), "timeout-reads/op")
		})
	}
}
