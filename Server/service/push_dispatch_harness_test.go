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
	"sync"
	"testing"
	"time"

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
	mustDo(t, "generating subscriber key", err)
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
	mustDo(t, "ephemeral public key", err)
	ecdhSecret, err := s.priv.ECDH(ephemeralPub)
	mustDo(t, "ECDH", err)
	receiverPub := s.priv.PublicKey().Bytes()
	keyInfo := "WebPush: info\x00" + string(receiverPub) + string(ephemeralPubBytes)
	ikm, err := hkdf.Key(sha256.New, ecdhSecret, s.authRaw, keyInfo, sha256.Size)
	mustDo(t, "deriving IKM", err)
	cek, err := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: aes128gcm\x00", 16)
	mustDo(t, "deriving CEK", err)
	nonce, err := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: nonce\x00", 12)
	mustDo(t, "deriving nonce", err)
	block, err := aes.NewCipher(cek)
	mustDo(t, "aes cipher", err)
	gcm, err := cipher.NewGCM(block)
	mustDo(t, "gcm", err)
	paddedPlaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	mustDo(t, "gcm open", err)
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
	mustDo(t, "ListPushSubscriptionsForDispatch", err)
	return len(rows)
}
