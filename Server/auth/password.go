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
// (measured: ~160-240 ms depending on the host), so a slot of the admission
// budget is held about as long as before.
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

// argon2MemoryBudgetKiB bounds the working memory all argon2id computations
// hold at once: four checks at 64 MiB. The process footprint runs to about
// twice this until the GC returns it (~0.6 GB measured however many wait), so it stays inside a
// 1 GB container. The admission budget counts computations, and an admin may
// raise it far past what the host's memory allows; past this many,
// computations wait for one to finish.
const argon2MemoryBudgetKiB = 256 * 1024

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
	dummyBcrypt = nil
}

// ErrPasswordTooShort is returned when the password is below the minimum length.
var ErrPasswordTooShort = errors.New("password must be at least 8 characters")

// ErrPasswordTooLong is returned when the password exceeds bcrypt's 72-byte limit.
var ErrPasswordTooLong = errors.New("password must not exceed 72 characters")

const argon2Prefix = "$argon2id$"

var b64 = base64.RawStdEncoding

// MaxPasswordBytes is the longest password HashPassword accepts.
const MaxPasswordBytes = maxPassLen

// errHashTooLong keeps the 72-byte ceiling bcrypt enforced at hash time, so a
// path that hashes without validating first still refuses a longer password.
var errHashTooLong = errors.New("password length exceeds 72 bytes")

// HashPassword returns an argon2id hash of password in the PHC string format.
// A password over 72 bytes is refused.
func HashPassword(password string) (string, error) {
	if len(password) > maxPassLen {
		return "", fmt.Errorf("hash password: %w", errHashTooLong)
	}
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
	noteHashWork("argon2id")
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
	p, ok = parseArgon2Settings(parts[3])
	if !ok {
		return argon2Params{}, nil, nil, false
	}
	salt, okSalt := decodeBounded(parts[4], minStoredArgon2SaltLen, maxStoredArgon2SaltLen)
	key, okKey := decodeBounded(parts[5], minStoredArgon2KeyLen, maxStoredArgon2KeyLen)
	if !okSalt || !okKey {
		return argon2Params{}, nil, nil, false
	}
	p.saltLen = len(salt)
	p.keyLen = uint32(len(key)) //nolint:gosec // G115: bounded by maxStoredArgon2KeyLen
	return p, salt, key, true
}

// parseArgon2Settings reads "m=<KiB>,t=<passes>,p=<threads>" in that order,
// within the stored-hash bounds.
func parseArgon2Settings(field string) (p argon2Params, ok bool) {
	fields := strings.Split(field, ",")
	if len(fields) != 3 {
		return argon2Params{}, false
	}
	var v [3]uint64
	for i, name := range []string{"m=", "t=", "p="} {
		digits, found := strings.CutPrefix(fields[i], name)
		if !found {
			return argon2Params{}, false
		}
		n, err := strconv.ParseUint(digits, 10, 32)
		if err != nil {
			return argon2Params{}, false
		}
		v[i] = n
	}
	m, t, th := v[0], v[1], v[2]
	if th < 1 || th > maxStoredArgon2Threads || t < 1 || t > maxStoredArgon2Time ||
		m < 8*th || m > maxStoredArgon2MemoryKiB {
		return argon2Params{}, false
	}
	//nolint:gosec // G115: each value is bounded just above
	return argon2Params{memoryKiB: uint32(m), time: uint32(t), threads: uint8(th)}, true
}

// decodeBounded decodes unpadded standard base64 of minLen to maxLen bytes.
func decodeBounded(s string, minLen, maxLen int) ([]byte, bool) {
	b, err := b64.Strict().DecodeString(s)
	if err != nil || len(b) < minLen || len(b) > maxLen {
		return nil, false
	}
	return b, true
}

// dummyHash and dummyBcrypt are lazily computed hashes of a password nobody
// holds. A failed check runs one bcrypt and one argon2id computation whatever
// the account holds (no account, a bcrypt hash or an argon2id hash), so the
// work a refusal costs does not depend on the account's state.
var (
	dummyHash     string
	dummyBcrypt   []byte
	dummyHashOnce sync.Once
)

func initDummyHashes() {
	dummyHashOnce.Do(func() {
		h, err := hashArgon2("dummy-timing-pad", argon2Cur)
		if err != nil {
			// crypto/rand is required for the server to function; no recovery path.
			panic("auth: failed to generate dummy password hash: " + err.Error())
		}
		b, err := bcrypt.GenerateFromPassword([]byte("dummy-timing-pad"), bcryptCost)
		if err != nil {
			panic("auth: failed to generate dummy bcrypt hash: " + err.Error())
		}
		dummyHash, dummyBcrypt = h, b
	})
}

// hashWorkHook, when set by a test, is told of each password-hash computation.
var hashWorkHook func(scheme string)

func noteHashWork(scheme string) {
	if hashWorkHook != nil {
		hashWorkHook(scheme)
	}
}

func compareBcrypt(hash []byte, password string) bool {
	// A malformed hash is refused before any work, so it is not counted.
	if _, err := bcrypt.Cost(hash); err == nil {
		noteHashWork("bcrypt")
	}
	return bcrypt.CompareHashAndPassword(hash, []byte(password)) == nil
}

// CheckPassword reports whether password matches hash; any error, including an
// empty or malformed hash, is false. An empty hash (no such user) still runs
// the same work as a wrong password.
func CheckPassword(hash, password string) bool {
	matched, _ := VerifyPassword(hash, password)
	return matched
}

// VerifyPassword reports whether password matches hash, which may be argon2id
// or bcrypt. needsRehash is true on a match whose hash is not argon2id at the
// current settings, so the caller can store HashPassword's result in its place.
// An empty hash (no such user) is a mismatch. Every mismatch on a well-formed
// or empty hash, or on a placeholder, runs one bcrypt and one argon2id computation.
func VerifyPassword(hash, password string) (matched, needsRehash bool) {
	initDummyHashes()
	switch {
	case hash == "":
		_ = compareBcrypt(dummyBcrypt, password)
		_ = verifyArgon2(dummyHash, password)
		return false, false
	case strings.HasPrefix(hash, argon2Prefix):
		p, salt, key, ok := parseArgon2(hash)
		if !ok {
			return false, false
		}
		if subtle.ConstantTimeCompare(computeArgon2(password, salt, p), key) != 1 {
			_ = compareBcrypt(dummyBcrypt, password)
			return false, false
		}
		return true, p != argon2Cur
	case !strings.HasPrefix(hash, "$2"):
		// A placeholder such as "!" (an imported account with no password yet)
		// matches nothing, but still costs what any other refusal does.
		_ = compareBcrypt(dummyBcrypt, password)
		_ = verifyArgon2(dummyHash, password)
		return false, false
	case compareBcrypt([]byte(hash), password):
		return true, true
	default:
		_ = verifyArgon2(dummyHash, password)
		return false, false
	}
}

func verifyArgon2(encoded, password string) bool {
	p, salt, key, ok := parseArgon2(encoded)
	if !ok {
		return false
	}
	return subtle.ConstantTimeCompare(computeArgon2(password, salt, p), key) == 1
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
