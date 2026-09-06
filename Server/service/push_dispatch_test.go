package service

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/safefetch"
)

// ─── test fixtures ──────────────────────────────────────────────────────────

// pushTestSubscriber is a full receiver identity: a real P-256 key pair and
// auth secret, so a message encryptWebPushMessage produces for it is
// genuinely decryptable — the only way to honestly prove the payload is
// what decision 2 says it is, rather than trusting the encryptor's own
// plaintext argument back to itself.
type pushTestSubscriber struct {
	priv      *ecdh.PrivateKey
	authRaw   []byte
	p256dhB64 string
	authB64   string
}

func newPushTestSubscriber(t *testing.T) *pushTestSubscriber {
	t.Helper()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating subscriber key: %v", err)
	}
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		t.Fatalf("generating auth secret: %v", err)
	}
	return &pushTestSubscriber{
		priv:      priv,
		authRaw:   auth,
		p256dhB64: base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes()),
		authB64:   base64.RawURLEncoding.EncodeToString(auth),
	}
}

// decrypt reverses encryptWebPush from the receiver's side: parse the
// aes128gcm header, rebuild the ECDH shared secret with the subscriber's own
// private key, derive IKM/CEK/nonce exactly as RFC 8291/8188 specify, open
// the AEAD, and strip the padding delimiter. Test-only — production never
// needs to decrypt its own message.
func (s *pushTestSubscriber) decrypt(t *testing.T, body []byte) []byte {
	t.Helper()
	const headerPrefix = 16 + 4 + 1 // salt + rs + idlen
	if len(body) < headerPrefix {
		t.Fatalf("push body too short: %d bytes", len(body))
	}
	salt := body[:16]
	idlen := int(body[20])
	if len(body) < headerPrefix+idlen {
		t.Fatalf("push body too short for a %d-byte keyid: %d bytes", idlen, len(body))
	}
	ephemeralPubBytes := body[headerPrefix : headerPrefix+idlen]
	ciphertext := body[headerPrefix+idlen:]

	ephemeralPub, err := ecdh.P256().NewPublicKey(ephemeralPubBytes)
	if err != nil {
		t.Fatalf("ephemeral public key: %v", err)
	}
	ecdhSecret, err := s.priv.ECDH(ephemeralPub)
	if err != nil {
		t.Fatalf("ECDH: %v", err)
	}
	receiverPub := s.priv.PublicKey().Bytes()
	keyInfo := "WebPush: info\x00" + string(receiverPub) + string(ephemeralPubBytes)
	ikm, err := hkdf.Key(sha256.New, ecdhSecret, s.authRaw, keyInfo, sha256.Size)
	if err != nil {
		t.Fatalf("deriving IKM: %v", err)
	}
	cek, err := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		t.Fatalf("deriving CEK: %v", err)
	}
	nonce, err := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		t.Fatalf("deriving nonce: %v", err)
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		t.Fatalf("aes cipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("gcm: %v", err)
	}
	paddedPlaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		t.Fatalf("gcm open: %v", err)
	}
	if len(paddedPlaintext) == 0 || paddedPlaintext[len(paddedPlaintext)-1] != pushPaddingDelimiter {
		t.Fatalf("plaintext %x is missing the 0x02 padding delimiter", paddedPlaintext)
	}
	return paddedPlaintext[:len(paddedPlaintext)-1]
}

// pushFetchResult is one planned outcome for one Fetch call.
type pushFetchResult struct {
	status int
	err    error
}

// recordingPushFetcher is the stub every dispatch test uses in place of a
// real push service. Per-URL, it plays back a fixed sequence of results
// (repeating the last one past the end), and records every request it saw
// so a test can assert on which endpoints were actually reached, in what
// order, and with what body — never a real network call.
type recordingPushFetcher struct {
	mu       sync.Mutex
	perURL   map[string][]pushFetchResult
	handlers map[string]func(ctx context.Context) (*safefetch.Response, error)
	calls    []safefetch.Request
}

func newRecordingPushFetcher() *recordingPushFetcher {
	return &recordingPushFetcher{perURL: make(map[string][]pushFetchResult)}
}

// sequence plans url's results in order; the last one repeats for any call
// past the end of the list.
func (f *recordingPushFetcher) sequence(url string, results ...pushFetchResult) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.perURL[url] = results
}

// always is sequence with one repeating status.
func (f *recordingPushFetcher) always(url string, status int) {
	f.sequence(url, pushFetchResult{status: status})
}

// onFetch installs a raw handler for url, bypassing sequence entirely —
// for a test that needs to run a side effect (flip a flag, revoke a role)
// exactly when the fetch happens, not just plan a status code in advance.
func (f *recordingPushFetcher) onFetch(url string, h func(ctx context.Context) (*safefetch.Response, error)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.handlers == nil {
		f.handlers = make(map[string]func(context.Context) (*safefetch.Response, error))
	}
	f.handlers[url] = h
}

// block makes url's Fetch hang until the returned release func is called
// (or the caller's context ends), then answer 201 — used to prove a stalled
// subscription does not stop concurrent delivery to the others.
func (f *recordingPushFetcher) block(url string) (release func()) {
	gate := make(chan struct{})
	f.onFetch(url, func(ctx context.Context) (*safefetch.Response, error) {
		select {
		case <-gate:
		case <-ctx.Done():
		}
		return &safefetch.Response{StatusCode: 201}, nil
	})
	var once sync.Once
	return func() { once.Do(func() { close(gate) }) }
}

func (f *recordingPushFetcher) Fetch(ctx context.Context, req safefetch.Request) (*safefetch.Response, error) {
	f.mu.Lock()
	if h, ok := f.handlers[req.URL]; ok {
		f.calls = append(f.calls, req)
		f.mu.Unlock()
		return h(ctx)
	}
	seenBefore := 0
	for _, c := range f.calls {
		if c.URL == req.URL {
			seenBefore++
		}
	}
	f.calls = append(f.calls, req)
	seq := f.perURL[req.URL]
	f.mu.Unlock()
	if len(seq) == 0 {
		return &safefetch.Response{StatusCode: 201}, nil
	}
	idx := seenBefore
	if idx >= len(seq) {
		idx = len(seq) - 1
	}
	r := seq[idx]
	if r.err != nil {
		return nil, r.err
	}
	return &safefetch.Response{StatusCode: r.status}, nil
}

func (f *recordingPushFetcher) urls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.calls))
	for i, c := range f.calls {
		out[i] = c.URL
	}
	return out
}

func (f *recordingPushFetcher) countFor(url string) int {
	n := 0
	for _, u := range f.urls() {
		if u == url {
			n++
		}
	}
	return n
}

func (f *recordingPushFetcher) bodyFor(url string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c.URL == url {
			return c.Body
		}
	}
	return nil
}

// noSleep replaces PushDispatcher.sleep in every retry test so a 3-attempt
// budget with a 1s/4s backoff schedule does not cost the suite 5 real
// seconds per test.
func noSleep(context.Context, time.Duration) {}

// pushDispatchFixture is the common setup every PushDispatcher test starts
// from: a role with READ+SEND, a channel, a real VAPID key, and the
// permission service the dispatcher shares with everything else.
type pushDispatchFixture struct {
	database *db.DB
	perms    *PermissionService
	push     *PushService
	keyID    string
}

func newPushDispatchFixture(t *testing.T) *pushDispatchFixture {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: 4, Name: "Member", Permissions: permissions.ReadMessages | permissions.SendMessages, Position: 1})

	pushSvc := NewPushService(database)
	pushSvc.SetVAPIDKey(genTestVAPIDKey(t))
	_, keyID, _ := pushSvc.PublicKey()

	return &pushDispatchFixture{
		database: database,
		perms:    NewPermissionService(database, permissions.NewChecker(database)),
		push:     pushSvc,
		keyID:    keyID,
	}
}

// subscribe seeds a real, decryptable subscription for userID and returns
// its endpoint and the subscriber identity for decrypting a body sent to it.
func (f *pushDispatchFixture) subscribe(t *testing.T, userID int64, endpoint string) *pushTestSubscriber {
	t.Helper()
	sub := newPushTestSubscriber(t)
	if _, err := f.database.UpsertPushSubscription(context.Background(), userID, endpoint, sub.p256dhB64, sub.authB64, "d", f.keyID, 10); err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}
	return sub
}

// subscriptionCount reports how many rows dispatch would see for userID
// under the fixture's key — used to prove a 410 actually pruned the row.
func (f *pushDispatchFixture) subscriptionCount(t *testing.T, userID int64) int {
	t.Helper()
	rows, err := f.database.ListPushSubscriptionsForDispatch(context.Background(), []int64{userID}, f.keyID)
	if err != nil {
		t.Fatalf("ListPushSubscriptionsForDispatch: %v", err)
	}
	return len(rows)
}

// ─── tests ──────────────────────────────────────────────────────────────────

// TestPushDispatch_OffByDefaultSendsNothing proves the compiled-default
// state (both push.enabled and push.dispatch_enabled false) at the point
// that matters: MessageService never calls a PushNotifier it was never
// given. Storage, the dispatcher and a real subscriber all exist and work
// (proved by the other tests below) — only the composition root's
// SetPushNotifier call is what dispatch is gated on, and it is never made
// here.
func TestPushDispatch_OffByDefaultSendsNothing(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	f.subscribe(t, 2, "https://push.example.net/a")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)

	msgSvc := NewMessageService(f.database, f.perms, nil)
	msgSvc.RunBackgroundInlineForTest()
	// The one line every other test's composition root would run — never
	// called here.
	_ = dispatcher

	if _, err := msgSvc.SendMessage(context.Background(), SendMessageParams{
		UserID: 1, ChannelID: 10, Username: "u1", Content: "@" + seedUsername(2) + " hi",
	}); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	if urls := fetch.urls(); len(urls) != 0 {
		t.Errorf("fetch calls = %v, want none: dispatch must stay off until SetPushNotifier is called", urls)
	}
	if d, fl, p := dispatcher.Counters(); d != 0 || fl != 0 || p != 0 {
		t.Errorf("counters = %d/%d/%d, want 0/0/0", d, fl, p)
	}
}

// TestPushDispatch_PayloadIsGenericAlways decrypts the body dispatch sent
// with the subscriber's own private key and proves it is exactly
// {"t":"activity"} — HP-5 scorecard Question 6, decision 2 — for both a
// guild-channel push and a DM push.
func TestPushDispatch_PayloadIsGenericAlways(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	sub := f.subscribe(t, 2, "https://push.example.net/generic")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)

	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	body := fetch.bodyFor("https://push.example.net/generic")
	if body == nil {
		t.Fatal("no push was sent to the subscriber")
	}
	plaintext := sub.decrypt(t, body)
	if string(plaintext) != `{"t":"activity"}` {
		t.Errorf("decrypted payload = %q, want %q", plaintext, `{"t":"activity"}`)
	}
}

// TestPushDispatch_SkipsAuthorOnlineAndUnauthorized proves the three
// audience filters that are not "has a subscription": the author is never
// pushed to even if mentioned, an online subscriber is skipped (their
// client already has the message), and a subscriber who lost CanViewChannel
// between the event and the dispatch gets nothing — even a generic ping
// would be a timing oracle for a channel they can no longer read.
func TestPushDispatch_SkipsAuthorOnlineAndUnauthorized(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	for _, uid := range []int64{1, 2, 3} {
		seedUserRole(t, f.database, uid, 4)
	}
	f.subscribe(t, 1, "https://push.example.net/author")
	f.subscribe(t, 2, "https://push.example.net/online")
	f.subscribe(t, 3, "https://push.example.net/revoked")

	// user 3 loses READ_MESSAGES after subscribing — a role swap to one
	// with no bits at all, simulating "lost access between the event and
	// the dispatch".
	seedRole(t, f.database, &db.Role{ID: 5, Name: "Restricted", Permissions: 0, Position: 0})
	seedUserRole(t, f.database, 3, 5)
	f.perms.InvalidateAll()

	fetch := newRecordingPushFetcher()
	online := func(uid int64) bool { return uid == 2 }
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, online, fetch)

	dispatcher.Notify(context.Background(), 10, 1, []int64{1, 2, 3})

	if urls := fetch.urls(); len(urls) != 0 {
		t.Errorf("fetch calls = %v, want none (author, online, and unauthorized subscribers all excluded)", urls)
	}
	if d, fl, p := dispatcher.Counters(); d != 0 || fl != 0 || p != 0 {
		t.Errorf("counters = %d/%d/%d, want 0/0/0", d, fl, p)
	}
}

// TestPushDispatch_LabelledChannelSendsNothingUnacknowledged: B5-7's
// nsfw_acknowledgements table does not exist on this branch, so a labelled
// channel gets no push at all — not even to a subscriber who would
// otherwise pass every other check.
func TestPushDispatch_LabelledChannelSendsNothingUnacknowledged(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "nsfw-general", Type: "text"})
	if _, err := f.database.ExecContext(context.Background(), `UPDATE channels SET nsfw = 1 WHERE id = ?`, int64(10)); err != nil {
		t.Fatal(err)
	}
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	f.subscribe(t, 2, "https://push.example.net/nsfw")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if urls := fetch.urls(); len(urls) != 0 {
		t.Errorf("fetch calls = %v, want none for a labelled channel", urls)
	}
}

// TestPushDispatch_DMOnlyParticipants proves the DM audience is exactly the
// participant set: a non-participant candidate (however it ended up in the
// caller's candidate list) gets nothing, because CanViewChannel for a DM is
// participation, not a role bit.
func TestPushDispatch_DMOnlyParticipants(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 20, Type: "dm"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	seedUserRole(t, f.database, 3, 4)
	seedDMParticipant(t, f.database, 20, 1)
	seedDMParticipant(t, f.database, 20, 2)
	// user 3 is NOT a participant of this DM.
	f.subscribe(t, 2, "https://push.example.net/participant")
	f.subscribe(t, 3, "https://push.example.net/outsider")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)
	dispatcher.Notify(context.Background(), 20, 1, []int64{2, 3})

	urls := fetch.urls()
	if len(urls) != 1 || urls[0] != "https://push.example.net/participant" {
		t.Errorf("fetch calls = %v, want exactly the participant's endpoint", urls)
	}
}

// TestPushDispatch_410PrunesTheRow proves the authoritative staleness
// signal: a 404 or 410 deletes the subscription row and counts it pruned,
// never failed.
func TestPushDispatch_410PrunesTheRow(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	f.subscribe(t, 2, "https://push.example.net/gone")

	fetch := newRecordingPushFetcher()
	fetch.always("https://push.example.net/gone", 410)
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	d, fl, p := dispatcher.Counters()
	if d != 0 || fl != 0 || p != 1 {
		t.Errorf("counters = %d/%d/%d, want 0/0/1", d, fl, p)
	}
	if n := f.subscriptionCount(t, 2); n != 0 {
		t.Errorf("subscription still present after a 410: %d rows, want 0", n)
	}
	if got := fetch.countFor("https://push.example.net/gone"); got != 1 {
		t.Errorf("fetch was called %d times for a 410, want exactly 1 (no retry)", got)
	}
}

// TestPushDispatch_RetryBudgetThenDrop proves the bounded retry budget: a
// transient failure (5xx here) is retried up to pushMaxAttempts times, then
// dropped and counted failed — nothing is written per attempt, and the
// subscription row survives (a 5xx names a transient problem, not a dead
// endpoint).
func TestPushDispatch_RetryBudgetThenDrop(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	f.subscribe(t, 2, "https://push.example.net/flaky")

	fetch := newRecordingPushFetcher()
	fetch.always("https://push.example.net/flaky", 503)
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)
	dispatcher.sleep = noSleep

	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if got := fetch.countFor("https://push.example.net/flaky"); got != pushMaxAttempts {
		t.Errorf("fetch was called %d times, want exactly %d (the retry budget)", got, pushMaxAttempts)
	}
	d, fl, p := dispatcher.Counters()
	if d != 0 || fl != 1 || p != 0 {
		t.Errorf("counters = %d/%d/%d, want 0/1/0", d, fl, p)
	}
	if n := f.subscriptionCount(t, 2); n != 1 {
		t.Errorf("subscription removed after a transient failure: %d rows, want 1 (a 5xx is not a dead endpoint)", n)
	}
}

// TestPushDispatch_CoalescesPerUserPerChannel proves the 60s-per-user-per-
// channel coalescer: a second Notify for the same user and channel within
// the window sends nothing more, even though the user is (still) eligible.
func TestPushDispatch_CoalescesPerUserPerChannel(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	f.subscribe(t, 2, "https://push.example.net/coalesce")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)

	dispatcher.Notify(context.Background(), 10, 1, []int64{2})
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if got := fetch.countFor("https://push.example.net/coalesce"); got != 1 {
		t.Errorf("fetch was called %d times across two sends inside the coalescing window, want 1", got)
	}
	if d, _, _ := dispatcher.Counters(); d != 1 {
		t.Errorf("dispatched = %d, want 1", d)
	}
}

// TestPushDispatch_EndpointsAreOnlyStoredOnes proves there is no relay: the
// set of URLs dispatch ever calls Fetch with is exactly the set of stored
// push_subscriptions.endpoint values, for every subscriber pushed to.
func TestPushDispatch_EndpointsAreOnlyStoredOnes(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	seedUserRole(t, f.database, 3, 4)
	f.subscribe(t, 2, "https://push.example.net/one")
	f.subscribe(t, 3, "https://push.example.net/two")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2, 3})

	want := map[string]bool{"https://push.example.net/one": true, "https://push.example.net/two": true}
	got := map[string]bool{}
	for _, u := range fetch.urls() {
		got[u] = true
	}
	if len(got) != len(want) {
		t.Fatalf("requested URLs = %v, want exactly %v", got, want)
	}
	for u := range want {
		if !got[u] {
			t.Errorf("stored endpoint %q was never requested", u)
		}
	}
}

// TestPushDispatch_HostileEndpointResolvingPrivateIsRefused runs the
// PRODUCTION policy (pushPolicy, every ceiling identical to the real
// Fetcher) with only the Resolve seam swapped — legal here because this is
// a _test.go file (TestProductionPolicyShape enforces that no non-test file
// may do it). A subscription whose endpoint resolves to a private address
// must be refused by the same classifier the GIF proxy uses: no push
// reaches it, the attempt counts failed, and the row is not pruned (the
// endpoint may be perfectly fine and just resolving to a poisoned or
// misconfigured answer right now).
func TestPushDispatch_HostileEndpointResolvingPrivateIsRefused(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	f.subscribe(t, 2, "https://push.hostile.example/x")

	// P2-7: a Dial spy proves the classifier is what refused this, not some
	// downstream timeout that happens to land in the same counters --
	// removing the classification step would still leave this test green if
	// dialing 10.0.0.1 merely failed slowly, so the assertion that matters
	// is zero dials, not just the counters.
	var dialAttempts atomic.Int32
	policy := pushPolicy()
	policy.Resolve = func(_ context.Context, _ string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("10.0.0.1")}, nil
	}
	policy.Dial = func(_ context.Context, network, addr string) (net.Conn, error) {
		dialAttempts.Add(1)
		return nil, fmt.Errorf("test dial spy: must never be called for %s %s", network, addr)
	}
	fetcher, err := safefetch.New(policy)
	if err != nil {
		t.Fatalf("safefetch.New: %v", err)
	}

	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetcher)
	dispatcher.sleep = noSleep
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	d, fl, p := dispatcher.Counters()
	if d != 0 || fl != 1 || p != 0 {
		t.Errorf("counters = %d/%d/%d, want 0/1/0 (refused, not delivered, not pruned)", d, fl, p)
	}
	if n := f.subscriptionCount(t, 2); n != 1 {
		t.Errorf("subscription removed after a refused connect: %d rows, want 1", n)
	}
	if got := dialAttempts.Load(); got != 0 {
		t.Errorf("dial attempts = %d, want 0 -- the classifier must refuse before any connect", got)
	}
}

// TestPushDispatch_ClassificationRemovedWouldDial is revert-proof (k) for
// the test above: with Resolve still pointing at 10.0.0.1 but Classify
// relaxed to accept it (standing in for "the classification step was
// removed"), the Dial spy above DOES see a dial -- proving that spy is
// actually load-bearing and not a vacuous assertion.
func TestPushDispatch_ClassificationRemovedWouldDial(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	f.subscribe(t, 2, "https://push.hostile.example/x")

	var dialAttempts atomic.Int32
	policy := pushPolicy()
	policy.Resolve = func(_ context.Context, _ string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("10.0.0.1")}, nil
	}
	policy.Classify = func(netip.Addr) error { return nil } // stands in for "classification removed"
	policy.Dial = func(_ context.Context, network, addr string) (net.Conn, error) {
		dialAttempts.Add(1)
		return nil, fmt.Errorf("test dial spy: refusing to actually connect to %s %s", network, addr)
	}
	fetcher, err := safefetch.New(policy)
	if err != nil {
		t.Fatalf("safefetch.New: %v", err)
	}

	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetcher)
	dispatcher.sleep = noSleep
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if got := dialAttempts.Load(); got == 0 {
		t.Error("dial attempts = 0 with classification relaxed -- the spy should have seen a dial")
	}
}

// TestPushDispatch_Empty201IsSuccessNotRetry drives the REAL pushPolicy()
// Fetcher (every ceiling as production has them) against an httptest server
// answering 201 with no body and no Content-Type — the shape a push service
// answers with on success (RFC 8030). Loopback and plain http are relaxed
// only through the test-side Classify seam, the way
// api/gif_handler_test.go's SetGIFUpstreamForTest does for the GIF proxy's
// production policy. Before the safefetch fix this was refused, retried
// twice more (delivering the same push up to three times) and counted
// failed; it must now be exactly one request and one dispatched.
func TestPushDispatch_Empty201IsSuccessNotRetry(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)

	var requests atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header()["Content-Type"] = nil
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(srv.Close)
	f.subscribe(t, 2, srv.URL+"/push")

	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", srv.URL, err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("stub server %q has no port: %v", srv.URL, err)
	}
	policy := pushPolicy()
	policy.Schemes = []string{u.Scheme}
	policy.Ports = []int{port}
	policy.Classify = func(addr netip.Addr) error {
		if addr.Unmap().IsLoopback() {
			return nil
		}
		return safefetch.ClassifyAddr(addr)
	}
	fetcher, err := safefetch.New(policy)
	if err != nil {
		t.Fatalf("safefetch.New: %v", err)
	}

	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetcher)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if got := requests.Load(); got != 1 {
		t.Errorf("upstream saw %d requests, want exactly 1 (no retry on a valid empty 201)", got)
	}
	d, fl, p := dispatcher.Counters()
	if d != 1 || fl != 0 || p != 0 {
		t.Errorf("counters = %d/%d/%d, want 1/0/0", d, fl, p)
	}
}

// TestAbsenceContract_NoPushRelay: no push.* config key names a relay or
// gateway host, and the set of endpoints dispatch ever requests is exactly
// the stored set — every push goes straight to the subscriber's own
// endpoint, never to an OwnCord-operated host in between.
func TestAbsenceContract_NoPushRelay(t *testing.T) {
	relayPattern := regexp.MustCompile(`(?i)relay`)
	pushType := reflect.TypeFor[config.PushConfig]()
	for field := range pushType.Fields() {
		tag, ok := field.Tag.Lookup("koanf")
		if !ok || tag == "" || tag == "-" {
			continue
		}
		if relayPattern.MatchString(tag) {
			t.Errorf("config key push.%s matches %q — every push goes to the subscriber's own endpoint, never a relay", tag, relayPattern)
		}
	}

	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	f.subscribe(t, 2, "https://push.example.net/only-endpoint")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	for _, u := range fetch.urls() {
		if u != "https://push.example.net/only-endpoint" {
			t.Errorf("dispatch requested %q, which is not the stored endpoint", u)
		}
	}
	if len(fetch.urls()) == 0 {
		t.Fatal("no request was made — the test proves nothing")
	}
}

// TestPushDispatch_SendOneWrapsAFetchError is a small unit check that a
// network-level error (not a status code) is treated the same as a 5xx:
// retried, then counted failed once the budget runs out.
func TestPushDispatch_SendOneWrapsAFetchError(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	f.subscribe(t, 2, "https://push.example.net/network-error")

	fetch := newRecordingPushFetcher()
	fetch.sequence("https://push.example.net/network-error",
		pushFetchResult{err: errors.New("connection reset")},
		pushFetchResult{err: errors.New("connection reset")},
		pushFetchResult{err: errors.New("connection reset")},
	)
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)
	dispatcher.sleep = noSleep
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if got := fetch.countFor("https://push.example.net/network-error"); got != pushMaxAttempts {
		t.Errorf("fetch called %d times, want %d", got, pushMaxAttempts)
	}
	if _, fl, _ := dispatcher.Counters(); fl != 1 {
		t.Errorf("failed = %d, want 1", fl)
	}
}

// --- Codex review round: P1-1, P2-3, P2-4, P2-5, P2-6, P2-8 ---

// isGroupDMErrorStore overrides only IsGroupDM to fail, delegating
// everything else to the wrapped Store (the message_crud_test.go
// disconnectAfterWriteStore pattern) -- proves P2-3's fail-closed posture on
// a lookup error without needing a fake for the whole interface.
type isGroupDMErrorStore struct{ Store }

func (isGroupDMErrorStore) IsGroupDM(context.Context, int64) (bool, error) {
	return false, errors.New("boom")
}

// listBlockersErrorStore overrides only ListBlockersOf to fail, for P2-4's
// fail-closed test.
type listBlockersErrorStore struct{ Store }

func (listBlockersErrorStore) ListBlockersOf(context.Context, int64) ([]int64, error) {
	return nil, errors.New("boom")
}

// TestPushDispatch_RecheckBeforeEachAttempt_ComesOnline is P1-1: a recipient
// who comes online between the first (transiently failing) attempt and the
// retry must receive nothing on the retry -- stillEligible has to run again
// immediately before every attempt, not just once for the whole dispatch.
func TestPushDispatch_RecheckBeforeEachAttempt_ComesOnline(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	f.subscribe(t, 2, "https://push.example.net/goes-online")

	var wentOnline atomic.Bool
	online := func(uid int64) bool { return uid == 2 && wentOnline.Load() }

	fetch := newRecordingPushFetcher()
	var calls atomic.Int32
	fetch.onFetch("https://push.example.net/goes-online", func(context.Context) (*safefetch.Response, error) {
		n := calls.Add(1)
		if n > 1 {
			t.Error("a second attempt reached the fetcher after the recipient came online")
			return &safefetch.Response{StatusCode: 201}, nil
		}
		wentOnline.Store(true) // simulate: recipient connects right after the first attempt
		return &safefetch.Response{StatusCode: 503}, nil
	})

	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, online, fetch)
	dispatcher.sleep = noSleep
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if got := calls.Load(); got != 1 {
		t.Errorf("fetch was called %d times, want exactly 1 (the retry must be refused before it fetches)", got)
	}
	d, fl, p := dispatcher.Counters()
	if d != 0 || fl != 0 || p != 0 {
		t.Errorf("counters = %d/%d/%d, want 0/0/0", d, fl, p)
	}
}

// TestPushDispatch_RecheckBeforeEachAttempt_LosesAccess is P1-1's other
// half: a recipient whose CanViewChannel is revoked between the first
// (transiently failing) attempt and the retry must receive nothing on the
// retry.
func TestPushDispatch_RecheckBeforeEachAttempt_LosesAccess(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	seedRole(t, f.database, &db.Role{ID: 5, Name: "Restricted", Permissions: 0, Position: 0})
	f.subscribe(t, 2, "https://push.example.net/loses-access")

	fetch := newRecordingPushFetcher()
	var calls atomic.Int32
	fetch.onFetch("https://push.example.net/loses-access", func(ctx context.Context) (*safefetch.Response, error) {
		n := calls.Add(1)
		if n > 1 {
			t.Error("a second attempt reached the fetcher after access was revoked")
			return &safefetch.Response{StatusCode: 201}, nil
		}
		// Revoke between the first attempt and the retry.
		if _, err := f.database.ExecContext(ctx, `UPDATE users SET role_id = ? WHERE id = ?`, int64(5), int64(2)); err != nil {
			t.Fatal(err)
		}
		f.perms.InvalidateAll()
		return &safefetch.Response{StatusCode: 503}, nil
	})

	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)
	dispatcher.sleep = noSleep
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if got := calls.Load(); got != 1 {
		t.Errorf("fetch was called %d times, want exactly 1 (the retry must be refused before it fetches)", got)
	}
	d, fl, p := dispatcher.Counters()
	if d != 0 || fl != 0 || p != 0 {
		t.Errorf("counters = %d/%d/%d, want 0/0/0", d, fl, p)
	}
}

// TestPushDispatch_GroupDMExcluded is P2-3: a group DM has Type == "dm"
// too, but only one-to-one DMs are in scope for push.
func TestPushDispatch_GroupDMExcluded(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 20, Type: "dm"})
	if _, err := f.database.ExecContext(context.Background(), `UPDATE channels SET is_group = 1 WHERE id = ?`, int64(20)); err != nil {
		t.Fatal(err)
	}
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	seedDMParticipant(t, f.database, 20, 1)
	seedDMParticipant(t, f.database, 20, 2)
	f.subscribe(t, 2, "https://push.example.net/group-dm")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)
	dispatcher.Notify(context.Background(), 20, 1, []int64{2})

	if urls := fetch.urls(); len(urls) != 0 {
		t.Errorf("fetch calls = %v, want none for a group DM", urls)
	}
}

// TestPushDispatch_GroupDMLookupFailureFailsClosed: a lookup error is
// treated as "assume it's a group" -- no push, same as P2-4's block-lookup
// posture.
func TestPushDispatch_GroupDMLookupFailureFailsClosed(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 20, Type: "dm"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	seedDMParticipant(t, f.database, 20, 1)
	seedDMParticipant(t, f.database, 20, 2)
	f.subscribe(t, 2, "https://push.example.net/group-dm-lookup-fails")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(isGroupDMErrorStore{f.database}, f.perms, f.push, nil, fetch)
	dispatcher.Notify(context.Background(), 20, 1, []int64{2})

	if urls := fetch.urls(); len(urls) != 0 {
		t.Errorf("fetch calls = %v, want none: an IsGroupDM lookup failure must fail closed", urls)
	}
}

// TestPushDispatch_BlockedByAuthorExcluded is P2-4: a user who has blocked
// the author must never be pushed about the author's message, mirroring
// applyMentionCounts' ListBlockersOf(authorID) exclusion for badges.
func TestPushDispatch_BlockedByAuthorExcluded(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	seedBlock(t, f.database, 2, 1) // user 2 has blocked user 1 (the author)
	f.subscribe(t, 2, "https://push.example.net/blocker")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if urls := fetch.urls(); len(urls) != 0 {
		t.Errorf("fetch calls = %v, want none: the recipient blocked the author", urls)
	}
}

// TestPushDispatch_BlockerLookupFailureFailsClosed: a ListBlockersOf failure
// drops the whole round rather than risk pushing a blocker.
func TestPushDispatch_BlockerLookupFailureFailsClosed(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	f.subscribe(t, 2, "https://push.example.net/blocker-lookup-fails")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(listBlockersErrorStore{f.database}, f.perms, f.push, nil, fetch)
	dispatcher.Notify(context.Background(), 10, 1, []int64{2})

	if urls := fetch.urls(); len(urls) != 0 {
		t.Errorf("fetch calls = %v, want none: a blocker lookup failure must fail closed", urls)
	}
}

// TestPushDispatch_CoalesceMapEvictsExpiredAndCapsSize is P2-5: an expired
// entry is swept on a later call, and the map never grows past
// pushCoalesceMapCap even when every entry is still within its window.
func TestPushDispatch_CoalesceMapEvictsExpiredAndCapsSize(t *testing.T) {
	f := newPushDispatchFixture(t)
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, newRecordingPushFetcher())

	past := time.Now().Add(-2 * pushCoalesceWindow)
	if dispatcher.coalesced(1, 100, past) {
		t.Fatal("first call for a key must never itself report coalesced")
	}
	if len(dispatcher.lastSent) != 1 {
		t.Fatalf("lastSent has %d entries, want 1", len(dispatcher.lastSent))
	}
	dispatcher.coalesced(2, 200, time.Now())
	if _, ok := dispatcher.lastSent[pushCoalesceKey{userID: 1, channelID: 100}]; ok {
		t.Error("an entry older than the coalescing window survived a later call's sweep")
	}

	// Cap: every one of these is within the window, so only the cap
	// eviction -- not expiry -- can be what keeps the map bounded.
	now := time.Now()
	for i := range int64(pushCoalesceMapCap + 10) {
		dispatcher.coalesced(i, 1, now)
	}
	if len(dispatcher.lastSent) > pushCoalesceMapCap {
		t.Errorf("lastSent has %d entries after exceeding the cap, want <= %d", len(dispatcher.lastSent), pushCoalesceMapCap)
	}
}

// TestPushDispatch_ConcurrentSendsDoNotStarveOnAStall is P2-6: one stalled
// subscription must not stop the others sharing the dispatch from being
// attempted promptly.
func TestPushDispatch_ConcurrentSendsDoNotStarveOnAStall(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	for _, uid := range []int64{1, 2, 3, 4} {
		seedUserRole(t, f.database, uid, 4)
	}
	f.subscribe(t, 2, "https://push.example.net/stall")
	f.subscribe(t, 3, "https://push.example.net/fast-a")
	f.subscribe(t, 4, "https://push.example.net/fast-b")

	fetch := newRecordingPushFetcher()
	release := fetch.block("https://push.example.net/stall")
	defer release()

	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)
	done := make(chan struct{})
	go func() {
		dispatcher.Notify(context.Background(), 10, 1, []int64{2, 3, 4})
		close(done)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for fetch.countFor("https://push.example.net/fast-a") != 1 || fetch.countFor("https://push.example.net/fast-b") != 1 {
		if time.Now().After(deadline) {
			t.Fatal("the two healthy subscriptions were never attempted while the stalled one was in flight")
		}
		time.Sleep(2 * time.Millisecond)
	}
	release()
	<-done

	d, _, _ := dispatcher.Counters()
	if d != 3 {
		t.Errorf("dispatched = %d, want 3 (all three eventually succeed)", d)
	}
}

// TestPushDispatch_ThroughSendMessageHook is P2-8's positive half: a real
// SendMessage call, with the notifier installed, delivers through the
// background runner. The off-by-default half is
// TestPushDispatch_OffByDefaultSendsNothing, which already goes through the
// same SendMessage path with no notifier installed.
func TestPushDispatch_ThroughSendMessageHook(t *testing.T) {
	f := newPushDispatchFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	f.subscribe(t, 2, "https://push.example.net/via-sendmessage")

	fetch := newRecordingPushFetcher()
	dispatcher := NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)

	msgSvc := NewMessageService(f.database, f.perms, nil)
	msgSvc.RunBackgroundInlineForTest()
	msgSvc.SetPushNotifier(dispatcher)

	if _, err := msgSvc.SendMessage(context.Background(), SendMessageParams{
		UserID: 1, ChannelID: 10, Username: "u1", Content: "@" + seedUsername(2) + " hi",
	}); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	if got := fetch.countFor("https://push.example.net/via-sendmessage"); got != 1 {
		t.Errorf("fetch called %d times through the SendMessage hook, want 1", got)
	}
	if d, _, _ := dispatcher.Counters(); d != 1 {
		t.Errorf("dispatched = %d, want 1", d)
	}
}
