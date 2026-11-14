package auth_test

import (
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/J3vb/OwnCord/Server/auth"
)

// New hashes cost about what bcrypt at cost 12 did, so a sign-in holds an
// admission slot as long as before and both formats take the same time.
func TestPasswordArgon2ProductionSettings(t *testing.T) {
	if got, want := auth.ProductionArgon2ForTest, [3]uint32{64 * 1024, 4, 1}; got != want {
		t.Fatalf("production argon2id (memory KiB, passes, threads) = %v, want %v", got, want)
	}
	if auth.Argon2MemoryBudgetKiBForTest < 4*64*1024 {
		t.Fatalf("memory budget %d KiB admits fewer than the default four concurrent checks", auth.Argon2MemoryBudgetKiBForTest)
	}
}

func TestVerifyPassword_LegacyBcryptMatchesAndAsksForRehash(t *testing.T) {
	legacy, err := bcrypt.GenerateFromPassword([]byte("old-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	matched, rehash := auth.VerifyPassword(string(legacy), "old-password")
	if !matched || !rehash {
		t.Fatalf("VerifyPassword(bcrypt, right) = %v, %v; want true, true", matched, rehash)
	}
	matched, rehash = auth.VerifyPassword(string(legacy), "wrong-password")
	if matched || rehash {
		t.Fatalf("VerifyPassword(bcrypt, wrong) = %v, %v; want false, false", matched, rehash)
	}
}

func TestVerifyPassword_CurrentArgon2NeedsNoRehash(t *testing.T) {
	hash, err := auth.HashPassword("current-password")
	if err != nil {
		t.Fatal(err)
	}
	matched, rehash := auth.VerifyPassword(hash, "current-password")
	if !matched || rehash {
		t.Fatalf("VerifyPassword(current) = %v, %v; want true, false", matched, rehash)
	}
	if matched, _ := auth.VerifyPassword(hash, "current-passwore"); matched {
		t.Fatal("a wrong password matched an argon2id hash")
	}
}

func TestVerifyPassword_OlderArgon2SettingsAskForRehash(t *testing.T) {
	hash, err := auth.HashArgon2ForTest("pw-older-settings", 32, 2, 1)
	if err != nil {
		t.Fatal(err)
	}
	matched, rehash := auth.VerifyPassword(hash, "pw-older-settings")
	if !matched || !rehash {
		t.Fatalf("VerifyPassword(other settings) = %v, %v; want true, true", matched, rehash)
	}
}

func TestVerifyPassword_RejectsMalformedAndOutOfBoundsHashes(t *testing.T) {
	good, err := auth.HashPassword("pw-for-mangling")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(good, "$")
	join := func(p ...string) string { return strings.Join(p, "$") }
	cases := map[string]string{
		"system account marker": "!",
		"argon2i variant":       join("", "argon2i", parts[2], parts[3], parts[4], parts[5]),
		"old version":           join("", "argon2id", "v=16", parts[3], parts[4], parts[5]),
		"missing field":         join("", "argon2id", parts[2], parts[3], parts[4]),
		"extra field":           good + "$x",
		"settings reordered":    join("", "argon2id", parts[2], "t=1,m=64,p=1", parts[4], parts[5]),
		"memory over bound":     join("", "argon2id", parts[2], "m=4194304,t=1,p=1", parts[4], parts[5]),
		"passes over bound":     join("", "argon2id", parts[2], "m=64,t=1000,p=1", parts[4], parts[5]),
		"zero threads":          join("", "argon2id", parts[2], "m=64,t=1,p=0", parts[4], parts[5]),
		"memory under threads":  join("", "argon2id", parts[2], "m=8,t=1,p=4", parts[4], parts[5]),
		"negative memory":       join("", "argon2id", parts[2], "m=-1,t=1,p=1", parts[4], parts[5]),
		"short salt":            join("", "argon2id", parts[2], parts[3], "AAAA", parts[5]),
		"padded salt":           join("", "argon2id", parts[2], parts[3], parts[4]+"==", parts[5]),
		"short key":             join("", "argon2id", parts[2], parts[3], parts[4], "AAAA"),
		"key not base64":        join("", "argon2id", parts[2], parts[3], parts[4], "!!!!!!!!!!!!!!!!!!!!!!!!"),
	}
	for name, hash := range cases {
		if matched, rehash := auth.VerifyPassword(hash, "pw-for-mangling"); matched || rehash {
			t.Errorf("%s: VerifyPassword(%q) = %v, %v; want false, false", name, hash, matched, rehash)
		}
	}
}

func TestVerifyPassword_EmptyHashRunsDummyAndFails(t *testing.T) {
	if matched, rehash := auth.VerifyPassword("", "anything-at-all"); matched || rehash {
		t.Fatalf("VerifyPassword(empty) = %v, %v; want false, false", matched, rehash)
	}
}

// Many computations at once never hold more than the memory budget.
func TestArgon2MemorySemaphoreBoundsConcurrentUse(t *testing.T) {
	const total, each, workers = 100, 30, 12
	acquire := auth.NewMemorySemaphoreForTest(total)
	var inUse, peak atomic.Int64
	var wg sync.WaitGroup
	for range workers {
		wg.Go(func() {
			release := acquire(each)
			n := inUse.Add(each)
			for {
				p := peak.Load()
				if n <= p || peak.CompareAndSwap(p, n) {
					break
				}
			}
			time.Sleep(5 * time.Millisecond)
			inUse.Add(-each)
			release()
			release()
		})
	}
	wg.Wait()
	if got := peak.Load(); got > total {
		t.Fatalf("peak memory in use = %d, want at most %d", got, total)
	}
	if got := peak.Load(); got < 2*each {
		t.Fatalf("peak memory in use = %d: the semaphore serialised work it had room for", got)
	}
	// A request larger than the whole budget takes all of it instead of waiting forever.
	release := acquire(total * 2)
	release()
}

func TestChannelPasswordStaysBcrypt(t *testing.T) {
	hash, err := auth.HashChannelPassword("room-key")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$2") {
		t.Fatalf("HashChannelPassword() = %q, want bcrypt", hash)
	}
	if !auth.CheckChannelPassword(hash, "room-key") || auth.CheckChannelPassword(hash, "room-kez") {
		t.Fatal("CheckChannelPassword does not tell the right key from a wrong one")
	}
	account, err := auth.HashPassword("room-key")
	if err != nil {
		t.Fatal(err)
	}
	if auth.CheckChannelPassword(account, "room-key") || auth.CheckChannelPassword("", "room-key") {
		t.Fatal("CheckChannelPassword accepted a hash that is not bcrypt")
	}
}
