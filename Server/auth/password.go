package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/bcrypt"
)

const (
	minPassLen = 8
	// maxPassLen stays at bcrypt's 72 bytes: accounts still on a bcrypt hash
	// must keep matching, and bcrypt silently truncates beyond it.
	maxPassLen = 72
)

// argon2Params are the argon2id settings new account hashes are made with.
type argon2Params struct {
	memoryKiB uint32
	time      uint32
	threads   uint8
	saltLen   int
	keyLen    uint32
}

// productionArgon2 costs about what bcrypt at cost 12 does on the same core
// (measured: ~240 ms on 2 vCPU), so a check takes as long whichever format the
// account holds and the unknown-user dummy check matches both, and a slot of
// the admission budget is held as long as before.
var productionArgon2 = argon2Params{memoryKiB: 64 * 1024, time: 4, threads: 1, saltLen: 16, keyLen: 32}

// testArgon2 is what SetCostForTesting switches to.
var testArgon2 = argon2Params{memoryKiB: 64, time: 1, threads: 1, saltLen: 16, keyLen: 32}

// Bounds a stored argon2id hash must sit within before it is computed, so a
// row restored from an edited backup cannot make one check allocate or spin
// without limit.
const (
	maxStoredArgon2MemoryKiB = 256 * 1024
	maxStoredArgon2Time      = 16
	maxStoredArgon2Threads   = 16
	minStoredArgon2KeyLen    = 16
	maxStoredArgon2KeyLen    = 64
	minStoredArgon2SaltLen   = 8
	maxStoredArgon2SaltLen   = 64
)

// argon2MemoryBudgetKiB bounds the memory all argon2id computations hold at
// once. The admission budget counts computations, and an admin may raise it
// far past what the host's memory allows at 64 MiB each; past this many,
// computations wait for one to finish.
const argon2MemoryBudgetKiB = 512 * 1024

// bcryptCost is a var so SetCostForTesting can lower it; production never mutates it.
var (
	bcryptCost = 12
	argon2Cur  = productionArgon2
	// argon2Mem holds one token per KiB in use, filled to argon2MemoryBudgetKiB.
	argon2Mem = newMemorySemaphore(argon2MemoryBudgetKiB)
)

// SetCostForTesting lowers the bcrypt cost and the argon2id settings, and
// resets the dummy timing pad so it is regenerated at the new cost. Call it
// from TestMain.
func SetCostForTesting(cost int) {
	bcryptCost = cost
	argon2Cur = testArgon2
	dummyHashOnce = sync.Once{}
	dummyHash = ""
}

// ErrPasswordTooShort is returned when the password is below the minimum length.
var ErrPasswordTooShort = errors.New("password must be at least 8 characters")

// ErrPasswordTooLong is returned when the password exceeds bcrypt's 72-byte limit.
var ErrPasswordTooLong = errors.New("password must not exceed 72 characters")

const argon2Prefix = "$argon2id$"

var b64 = base64.RawStdEncoding

// HashPassword returns an argon2id hash of password in the PHC string format.
func HashPassword(password string) (string, error) {
	hash, err := hashArgon2(password, argon2Cur)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return hash, nil
}

func hashArgon2(password string, p argon2Params) (string, error) {
	salt := make([]byte, p.saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("argon2id salt: %w", err)
	}
	key := computeArgon2(password, salt, p)
	return fmt.Sprintf("%sv=%d$m=%d,t=%d,p=%d$%s$%s", argon2Prefix, argon2.Version,
		p.memoryKiB, p.time, p.threads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// computeArgon2 runs argon2id inside the process-wide memory budget.
func computeArgon2(password string, salt []byte, p argon2Params) []byte {
	release := argon2Mem.acquire(p.memoryKiB)
	defer release()
	return argon2.IDKey([]byte(password), salt, p.time, p.memoryKiB, p.threads, p.keyLen)
}

// parseArgon2 reads a PHC argon2id string; ok is false for anything else or
// for settings outside the stored-hash bounds.
func parseArgon2(encoded string) (p argon2Params, salt, key []byte, ok bool) {
	parts := strings.Split(encoded, "$")
	// "", "argon2id", "v=19", "m=..,t=..,p=..", salt, key
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v="+strconv.Itoa(argon2.Version) {
		return argon2Params{}, nil, nil, false
	}
	var m, t, th uint64
	var err error
	fields := strings.Split(parts[3], ",")
	if len(fields) != 3 {
		return argon2Params{}, nil, nil, false
	}
	for i, want := range []string{"m=", "t=", "p="} {
		v, found := strings.CutPrefix(fields[i], want)
		if !found {
			return argon2Params{}, nil, nil, false
		}
		n, perr := strconv.ParseUint(v, 10, 32)
		if perr != nil {
			return argon2Params{}, nil, nil, false
		}
		switch i {
		case 0:
			m = n
		case 1:
			t = n
		default:
			th = n
		}
	}
	if th < 1 || th > maxStoredArgon2Threads || t < 1 || t > maxStoredArgon2Time ||
		m < 8*th || m > maxStoredArgon2MemoryKiB {
		return argon2Params{}, nil, nil, false
	}
	if salt, err = b64.Strict().DecodeString(parts[4]); err != nil ||
		len(salt) < minStoredArgon2SaltLen || len(salt) > maxStoredArgon2SaltLen {
		return argon2Params{}, nil, nil, false
	}
	if key, err = b64.Strict().DecodeString(parts[5]); err != nil ||
		len(key) < minStoredArgon2KeyLen || len(key) > maxStoredArgon2KeyLen {
		return argon2Params{}, nil, nil, false
	}
	p = argon2Params{memoryKiB: uint32(m), time: uint32(t), threads: uint8(th), saltLen: len(salt), keyLen: uint32(len(key))}
	return p, salt, key, true
}

// dummyHash is a lazily computed argon2id hash so CheckPassword takes roughly
// constant time whether or not a user exists.
var (
	dummyHash     string
	dummyHashOnce sync.Once
)

// getDummyHash returns the dummy hash, initialising it on first call.
func getDummyHash() string {
	dummyHashOnce.Do(func() {
		h, err := hashArgon2("dummy-timing-pad", argon2Cur)
		if err != nil {
			// crypto/rand is required for the server to function; no recovery path.
			panic("auth: failed to generate dummy password hash: " + err.Error())
		}
		dummyHash = h
	})
	return dummyHash
}

// CheckPassword reports whether password matches hash; any error, including an
// empty or malformed hash, is false. An empty hash (no such user) still runs a
// dummy comparison to prevent timing-based username enumeration.
func CheckPassword(hash, password string) bool {
	matched, _ := VerifyPassword(hash, password)
	return matched
}

// VerifyPassword reports whether password matches hash, which may be argon2id
// or bcrypt. needsRehash is true on a match whose hash is not argon2id at the
// current settings, so the caller can store HashPassword's result in its place.
// An empty hash (no such user) runs a dummy comparison and returns false.
func VerifyPassword(hash, password string) (matched, needsRehash bool) {
	if hash == "" {
		_, _ = verifyArgon2(getDummyHash(), password)
		return false, false
	}
	if strings.HasPrefix(hash, argon2Prefix) {
		p, ok := verifyArgon2(hash, password)
		if !ok {
			return false, false
		}
		return true, p != argon2Cur
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return false, false
	}
	return true, true
}

func verifyArgon2(encoded, password string) (p argon2Params, matched bool) {
	p, salt, key, ok := parseArgon2(encoded)
	if !ok {
		return argon2Params{}, false
	}
	got := computeArgon2(password, salt, p)
	return p, subtle.ConstantTimeCompare(got, key) == 1
}

// memorySemaphore hands out KiB of the argon2id memory budget; a request
// larger than the whole budget takes all of it.
type memorySemaphore struct {
	mu    sync.Mutex
	cond  *sync.Cond
	free  uint32
	total uint32
}

func newMemorySemaphore(total uint32) *memorySemaphore {
	s := &memorySemaphore{free: total, total: total}
	s.cond = sync.NewCond(&s.mu)
	return s
}

// acquire waits until n KiB are free and takes them. It cannot wait forever:
// every holder is a bounded argon2id computation that releases on return.
func (s *memorySemaphore) acquire(n uint32) (release func()) {
	n = min(n, s.total)
	s.mu.Lock()
	for s.free < n {
		s.cond.Wait()
	}
	s.free -= n
	s.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			s.free += n
			s.mu.Unlock()
			s.cond.Broadcast()
		})
	}
}

// HashChannelPassword returns a bcrypt hash of a voice channel password. A
// channel password is checked on voice join, outside the admission budget, so
// it stays on bcrypt, which needs no per-check memory.
func HashChannelPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", fmt.Errorf("hash channel password: %w", err)
	}
	return string(hash), nil
}

// CheckChannelPassword reports whether password matches a bcrypt channel
// password hash; anything else, an empty hash included, is false.
func CheckChannelPassword(hash, password string) bool {
	if !strings.HasPrefix(hash, "$2") {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// ValidatePasswordStrength requires 8 to 72 bytes (bcrypt's limit).
func ValidatePasswordStrength(password string) error {
	if len(password) < minPassLen {
		return ErrPasswordTooShort
	}
	if len(password) > maxPassLen {
		return ErrPasswordTooLong
	}
	return nil
}

// MaxChannelPasswordLen bounds a voice channel password, in characters.
const MaxChannelPasswordLen = 64

// ErrChannelPasswordInvalid is wrapped by ValidateChannelPassword; safe to show the admin.
var ErrChannelPasswordInvalid = errors.New("invalid channel password")

// ValidateChannelPassword checks a voice channel password: 1 to
// MaxChannelPasswordLen characters, no control characters, within bcrypt's 72
// bytes. It has no minimum strength, being a shared room key.
func ValidateChannelPassword(password string) error {
	n := utf8.RuneCountInString(password)
	switch {
	case n < 1:
		return fmt.Errorf("password must not be empty%.0w", ErrChannelPasswordInvalid)
	case n > MaxChannelPasswordLen:
		return fmt.Errorf("password must be at most %d characters%.0w", MaxChannelPasswordLen, ErrChannelPasswordInvalid)
	case len(password) > maxPassLen:
		return fmt.Errorf("password must be at most %d bytes%.0w", maxPassLen, ErrChannelPasswordInvalid)
	}
	for _, r := range password {
		if unicode.IsControl(r) {
			return fmt.Errorf("password must not contain control characters%.0w", ErrChannelPasswordInvalid)
		}
	}
	return nil
}
