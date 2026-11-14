package service

import (
	"context"
	"encoding/base64"
	"errors"
	"net/netip"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func pushSubscribeTo(t *testing.T, svc *PushService, endpoint string) error {
	t.Helper()
	_, err := svc.Subscribe(context.Background(), 1, PushSubscribeInput{
		Endpoint: endpoint,
		P256dh:   base64.RawURLEncoding.EncodeToString(validP256dhBytes(t)),
		Auth:     base64.RawURLEncoding.EncodeToString(make([]byte, 16)),
	})
	return err
}

func validP256dhBytes(t *testing.T) []byte {
	t.Helper()
	return genTestVAPIDKey(t).PublicKey().Bytes()
}

func newPushPublicSvc(t *testing.T, resolve PushResolver) *PushService {
	t.Helper()
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1})
	svc := NewPushService(database)
	svc.SetVAPIDKey(genTestVAPIDKey(t))
	svc.SetEndpointResolver(resolve)
	return svc
}

func resolvesTo(addrs ...string) PushResolver {
	return func(context.Context, string) ([]netip.Addr, error) {
		out := make([]netip.Addr, 0, len(addrs))
		for _, a := range addrs {
			out = append(out, netip.MustParseAddr(a))
		}
		return out, nil
	}
}

func TestSubscribe_PushServerAddressChecks(t *testing.T) {
	cases := []struct {
		name     string
		endpoint string
		resolve  PushResolver
		refused  bool
	}{
		{"public host", "https://ntfy.example/up", resolvesTo("8.8.8.8"), false},
		{"private host", "https://ntfy.lan/up", resolvesTo("192.168.1.5"), true},
		{"loopback host", "https://localhost/up", resolvesTo("127.0.0.1", "::1"), true},
		{"private IPv4 literal", "https://10.0.0.7/up", resolvesTo("8.8.8.8"), true},
		{"loopback IPv6 literal", "https://[::1]/up", resolvesTo("8.8.8.8"), true},
		{"public IPv4 literal", "https://1.1.1.1/up", resolvesTo("10.0.0.1"), false},
		{"public and private answers", "https://mixed.example/up", resolvesTo("8.8.8.8", "10.1.2.3"), true},
		{"IPv4-mapped private literal", "https://[::ffff:10.0.0.1]/up", resolvesTo("8.8.8.8"), true},
		{"NAT64 private literal", "https://[64:ff9b::a00:1]/up", resolvesTo("8.8.8.8"), true},
		{"unspecified literal", "https://0.0.0.0/up", resolvesTo("8.8.8.8"), true},
		{"explicit 443", "https://ntfy.example:443/up", resolvesTo("8.8.8.8"), false},
		{"empty answer: fail open", "https://empty.example/up", resolvesTo(), false},
		{"cgnat answer", "https://ts.example/up", resolvesTo("100.64.1.2"), true},
		{"lookup fails: fail open", "https://flaky.example/up", func(context.Context, string) ([]netip.Addr, error) {
			return nil, errors.New("servfail")
		}, false},
		{"lookup times out: fail open", "https://slow.example/up", func(ctx context.Context, _ string) ([]netip.Addr, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "lookup times out: fail open" && testing.Short() {
				t.Skip("waits out the 3 s lookup bound")
			}
			svc := newPushPublicSvc(t, tc.resolve)
			start := time.Now()
			err := pushSubscribeTo(t, svc, tc.endpoint)
			if tc.refused {
				if !errors.Is(err, ErrPushServerNotPublic) {
					t.Fatalf("Subscribe = %v, want ErrPushServerNotPublic", err)
				}
				rows, lerr := svc.List(context.Background(), 1)
				mustDo(t, "List", lerr)
				if len(rows) != 0 {
					t.Fatalf("a refused endpoint was stored: %+v", rows)
				}
				return
			}
			mustDo(t, "Subscribe", err)
			if d := time.Since(start); d > 2*pushResolveTimeout {
				t.Fatalf("Subscribe took %s, the lookup must be bounded", d)
			}
		})
	}
}

func TestSubscribe_RefusesAPortDispatchDoesNotSendTo(t *testing.T) {
	svc := newPushPublicSvc(t, resolvesTo("8.8.8.8"))
	err := pushSubscribeTo(t, svc, "https://ntfy.example:8443/up")
	if !errors.Is(err, ErrPushServerPortNotSupported) {
		t.Fatalf("Subscribe = %v, want ErrPushServerPortNotSupported", err)
	}
	rows, lerr := svc.List(context.Background(), 1)
	mustDo(t, "List", lerr)
	if len(rows) != 0 {
		t.Fatalf("a refused endpoint was stored: %+v", rows)
	}
}
