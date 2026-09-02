package api_test

// B3-1 characterization tests for the auth slice (docs/plans/
// b3-server-architecture-guardrails-2026-08-29.md §B3-1). Every row pins
// TODAY's behaviour of auth_handler.go and totp_handler.go so that B3-2 can
// move the orchestration into service.AuthService without changing it. A row
// that reveals a defect is pinned as-is with a `// known:` comment and a
// ledger entry — it is not fixed here.
//
// Only the gaps in auth_handler_test.go, totp_handler_test.go and
// auth_handler_delete_broadcast_test.go are filled; the inventory of what
// those files already pin is the table in the plan's B3-1 evidence block.
//
// Fault injection uses the database itself, so no handler is mocked:
//   - a SELECT fault is `ALTER TABLE x RENAME TO x_gone` (the sqlc query then
//     fails with "no such table", a wrapped error that is not a sentinel);
//   - a write fault is a BEFORE INSERT/UPDATE/DELETE trigger that RAISE(FAIL)s
//     (the pattern TestConfirmTOTP_RevokeFailureSurfacesWarning introduced).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"golang.org/x/crypto/bcrypt"
)

// ─── Harness ─────────────────────────────────────────────────────────────────

// errBody is the errorResponse shape every refusal in the slice uses.
type errBody struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// send issues one request against the mounted auth router. token, ip and ua
// are optional; the body is JSON-encoded unless it is already a []byte.
func send(t *testing.T, router http.Handler, method, path, token, ip, ua string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	switch b := body.(type) {
	case nil:
	case []byte:
		raw = b
	default:
		var err error
		if raw, err = json.Marshal(b); err != nil {
			t.Fatalf("marshal body: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	if ip == "" {
		ip = "127.0.0.1"
	}
	req.RemoteAddr = ip + ":9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func decodeErr(t *testing.T, rr *httptest.ResponseRecorder) errBody {
	t.Helper()
	var e errBody
	if err := json.Unmarshal(rr.Body.Bytes(), &e); err != nil {
		t.Fatalf("decode error body %q: %v", rr.Body.String(), err)
	}
	return e
}

// wantErr asserts status plus the exact error code and message.
func wantErr(t *testing.T, rr *httptest.ResponseRecorder, status int, code, message string) {
	t.Helper()
	if rr.Code != status {
		t.Fatalf("status = %d, want %d; body = %s", rr.Code, status, rr.Body.String())
	}
	e := decodeErr(t, rr)
	if e.Error != code || e.Message != message {
		t.Fatalf("body = {%q, %q}, want {%q, %q}", e.Error, e.Message, code, message)
	}
}

// hideTable makes every query against table fail with a non-sentinel error.
func hideTable(t *testing.T, database *db.DB, table string) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(), "ALTER TABLE "+table+" RENAME TO "+table+"_gone"); err != nil {
		t.Fatalf("hide %s: %v", table, err)
	}
}

// failWrite makes every `op` against table fail. op is INSERT, DELETE or
// "UPDATE OF <column>".
func failWrite(t *testing.T, database *db.DB, op, table string) {
	t.Helper()
	name := "fault_" + regexp.MustCompile(`[^a-z]+`).ReplaceAllString(strings.ToLower(op+"_"+table), "_")
	if _, err := database.ExecContext(context.Background(),
		"CREATE TRIGGER "+name+" BEFORE "+op+" ON "+table+" BEGIN SELECT RAISE(FAIL, 'injected fault'); END"); err != nil {
		t.Fatalf("install %s: %v", name, err)
	}
}

// seedUser creates a user with the given password and returns its ID.
func seedUser(t *testing.T, database *db.DB, username, password string, roleID int) int64 {
	t.Helper()
	hash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	uid, err := database.CreateUser(context.Background(), username, hash, roleID)
	if err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	return uid
}

// seedSession creates a login session for uid and returns the bearer token.
func seedSession(t *testing.T, database *db.DB, uid int64) string {
	t.Helper()
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return token
}

func setSetting(t *testing.T, database *db.DB, key, value string) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, key, value); err != nil {
		t.Fatalf("set %s: %v", key, err)
	}
}

func seedInvite(t *testing.T, database *db.DB) string {
	t.Helper()
	ownerID := seedUser(t, database, "inviteowner", "ownerPass1", 1)
	code, err := database.CreateInvite(context.Background(), ownerID, 1, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	return code
}

func inviteUseCount(t *testing.T, database *db.DB, code string) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), `SELECT use_count FROM invites WHERE code = ?`, code).Scan(&n); err != nil {
		t.Fatalf("invite use_count: %v", err)
	}
	return n
}

func userByName(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	u, err := database.GetUserByUsername(context.Background(), username)
	if err != nil {
		t.Fatalf("GetUserByUsername(%s): %v", username, err)
	}
	return u
}

// loginPartial logs in a TOTP-enrolled user and returns the partial token.
func loginPartial(t *testing.T, router http.Handler, username, password, ip, ua string) string {
	t.Helper()
	rr := send(t, router, http.MethodPost, "/api/v1/auth/login", "", ip, ua, map[string]string{"username": username, "password": password})
	if rr.Code != http.StatusOK {
		t.Fatalf("login status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	pt, _ := resp["partial_token"].(string)
	if pt == "" || resp["requires_2fa"] != true {
		t.Fatalf("expected a 2FA challenge, got %s", rr.Body.String())
	}
	return pt
}

// enrolTOTP stores secret for uid the way the confirm handler does
// (encrypted with the router's key) and returns the plaintext secret.
func enrolTOTP(t *testing.T, database *db.DB, uid int64) string {
	t.Helper()
	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		t.Fatalf("GenerateTOTPSecret: %v", err)
	}
	enc, err := auth.EncryptTOTPSecret(testTOTPKey, secret)
	if err != nil {
		t.Fatalf("EncryptTOTPSecret: %v", err)
	}
	if err := database.UpdateUserTOTPSecret(context.Background(), uid, &enc); err != nil {
		t.Fatalf("UpdateUserTOTPSecret: %v", err)
	}
	return secret
}

func totpCode(t *testing.T, secret string) string {
	t.Helper()
	code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}
	return code
}

// wrongTOTPCode returns a six-digit code the verifier rejects for secret:
// it differs from the codes of the previous, current and next 30-second
// steps, which are the three VerifyTOTPCode accepts, and from the step after
// that — the verifier samples the clock later than this helper, so a request
// that crosses a step boundary in between is checked against {0,+1,+2}. A
// constant such as "000000" collides with one of them once in ~333k runs.
func wrongTOTPCode(t *testing.T, secret string) string {
	t.Helper()
	now := time.Now().UTC()
	valid := map[string]bool{}
	for _, d := range []time.Duration{-30 * time.Second, 0, 30 * time.Second, 60 * time.Second} {
		code, err := auth.GenerateTOTPCode(secret, now.Add(d))
		if err != nil {
			t.Fatalf("GenerateTOTPCode: %v", err)
		}
		valid[code] = true
	}
	for i := range 5 {
		if code := fmt.Sprintf("%06d", i); !valid[code] {
			return code
		}
	}
	t.Fatal("unreachable: five candidates, at most four valid codes")
	return ""
}

// ─── Enumeration defence ─────────────────────────────────────────────────────

// Every credential rejection on /login is the same 401 — status, body,
// Content-Type and rate-limiter side effects — whether the account does not
// exist, exists, is banned, or is spelled in another case.
func TestAuthCharacterization_LoginRejectionsAreIndistinguishable(t *testing.T) {
	type outcome struct {
		status  int
		body    string
		ctype   string
		windows int
		locks   int
	}
	attempt := func(seed func(*db.DB), username string) outcome {
		database := newAuthTestDB(t)
		seed(database)
		limiter := auth.NewRateLimiter()
		router := buildAuthRouter(database, limiter)
		rr := send(t, router, http.MethodPost, "/api/v1/auth/login", "", "", "", map[string]string{"username": username, "password": "wrongPass1"})
		w, l := limiter.Len()
		return outcome{rr.Code, rr.Body.String(), rr.Header().Get("Content-Type"), w, l}
	}
	none := func(*db.DB) {}
	known := func(d *db.DB) { seedUser(t, d, "target", "correctPass1", 4) }
	banned := func(d *db.DB) {
		uid := seedUser(t, d, "target", "correctPass1", 4)
		if err := d.BanUser(context.Background(), uid, "characterization", nil); err != nil {
			t.Fatalf("BanUser: %v", err)
		}
	}
	rows := []struct {
		name     string
		seed     func(*db.DB)
		username string
	}{
		{"unknown user", none, "target"},
		{"wrong password", known, "target"},
		{"banned user, wrong password", banned, "target"},
		{"case variant, wrong password", known, "TARGET"},
	}
	ref := attempt(rows[0].seed, rows[0].username)
	if ref.status != http.StatusUnauthorized {
		t.Fatalf("reference status = %d, want 401; body = %s", ref.status, ref.body)
	}
	var e errBody
	if err := json.Unmarshal([]byte(ref.body), &e); err != nil || e.Error != "UNAUTHORIZED" || e.Message != "invalid credentials" {
		t.Fatalf("reference body = %s, want UNAUTHORIZED/invalid credentials", ref.body)
	}
	// One route window ("login:"+ip) plus the two failure windows
	// ("login_fail:"+ip, "login_user_fail:"+name); no lockout yet.
	if ref.windows != 3 || ref.locks != 0 {
		t.Fatalf("reference limiter state = %d windows / %d lockouts, want 3 / 0", ref.windows, ref.locks)
	}
	for _, row := range rows[1:] {
		if got := attempt(row.seed, row.username); got != ref {
			t.Errorf("%s: %+v, want byte-identical to unknown user %+v", row.name, got, ref)
		}
	}
}

// The timing class of an unknown-user rejection matches a wrong-password
// rejection: auth.CheckPassword runs a dummy bcrypt compare when there is no
// hash. The api suite hashes at bcrypt.MinCost, where the compare is too
// cheap to measure, so this row raises the cost for its own hashes only.
func TestAuthCharacterization_UnknownUserTakesAsLongAsWrongPassword(t *testing.T) {
	const cost = 10 // ~50-100 ms per compare: well above scheduler noise
	auth.SetCostForTesting(cost)
	t.Cleanup(func() { auth.SetCostForTesting(bcrypt.MinCost) })

	database := newAuthTestDB(t)
	seedUser(t, database, "timed", "correctPass1", 4)

	median := func(username string) time.Duration {
		samples := make([]time.Duration, 0, 3)
		for range 3 {
			// A fresh limiter per sample keeps every attempt inside the
			// per-IP route limit and the failure windows.
			router := buildAuthRouter(database, auth.NewRateLimiter())
			start := time.Now()
			rr := send(t, router, http.MethodPost, "/api/v1/auth/login", "", "", "", map[string]string{"username": username, "password": "wrongPass1"})
			samples = append(samples, time.Since(start))
			if rr.Code != http.StatusUnauthorized {
				t.Fatalf("%s: status = %d, want 401", username, rr.Code)
			}
		}
		slices.Sort(samples)
		return samples[1]
	}
	// Warm the dummy hash (sync.Once) so its one-off generation is not timed.
	auth.CheckPassword("", "warm")

	wrong := median("timed")
	unknown := median("nobody")
	if unknown < wrong/2 {
		t.Fatalf("unknown-user rejection took %v, wrong-password %v: the dummy bcrypt compare is not running on the unknown path", unknown, wrong)
	}
}

// Registration refusals that depend on state an attacker wants to probe —
// a taken username versus an unusable invite — share one 400 body.
func TestAuthCharacterization_RegisterRejectionsAreIndistinguishable(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildAuthRouter(database, auth.NewRateLimiter())
	seedUser(t, database, "taken", "somePass1", 4)
	code := seedInvite(t, database)
	past := time.Now().Add(-time.Hour)
	expired, err := database.CreateInvite(context.Background(), 1, 0, &past)
	if err != nil {
		t.Fatalf("CreateInvite(expired): %v", err)
	}

	// One IP per attempt: the register route allows 3/min per IP.
	register := func(username, invite, ip string) *httptest.ResponseRecorder {
		return send(t, router, http.MethodPost, "/api/v1/auth/register", "", ip, "",
			map[string]string{"username": username, "password": "securePass1", "invite_code": invite})
	}
	ref := register("taken", code, "203.0.113.1")
	wantErr(t, ref, http.StatusBadRequest, "INVALID_CREDENTIALS", "invalid invite or credentials")
	for name, rr := range map[string]*httptest.ResponseRecorder{
		"unknown invite": register("fresh", "no-such-invite", "203.0.113.2"),
		"expired invite": register("fresh", expired, "203.0.113.3"),
	} {
		if rr.Code != ref.Code || rr.Body.String() != ref.Body.String() {
			t.Errorf("%s: %d %s, want byte-identical to taken username %d %s", name, rr.Code, rr.Body.String(), ref.Code, ref.Body.String())
		}
	}
	if n := inviteUseCount(t, database, code); n != 0 {
		t.Errorf("invite use_count after rejected registrations = %d, want 0", n)
	}
}

// ─── Sentinel and failure-path mapping: /register ────────────────────────────

func TestAuthCharacterization_RegisterPolicyAndFailurePaths(t *testing.T) {
	body := func(invite string) map[string]string {
		return map[string]string{"username": "fresh", "password": "securePass1", "invite_code": invite}
	}
	t.Run("settings unreadable -> 500, no policy leak", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		code := seedInvite(t, database)
		hideTable(t, database, "settings")
		rr := send(t, router, http.MethodPost, "/api/v1/auth/register", "", "", "", body(code))
		wantErr(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to load registration policy")
	})
	t.Run("registration_mode unparsable -> fails closed, 403", func(t *testing.T) {
		// A value only a hand-edited database can hold (B4-1): treated as
		// closed rather than as a policy outage.
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		code := seedInvite(t, database)
		setSetting(t, database, "registration_mode", "maybe")
		rr := send(t, router, http.MethodPost, "/api/v1/auth/register", "", "", "", body(code))
		wantErr(t, rr, http.StatusForbidden, "FORBIDDEN", "registration is currently closed")
	})
	t.Run("require_2fa unparsable -> 500", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		code := seedInvite(t, database)
		setSetting(t, database, "require_2fa", "yes")
		rr := send(t, router, http.MethodPost, "/api/v1/auth/register", "", "", "", body(code))
		wantErr(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to load registration policy")
	})
	t.Run("settings rows absent -> defaults (invite-only, no 2FA) -> 201", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		code := seedInvite(t, database)
		if _, err := database.ExecContext(context.Background(), `DELETE FROM settings`); err != nil {
			t.Fatalf("clear settings: %v", err)
		}
		rr := send(t, router, http.MethodPost, "/api/v1/auth/register", "", "", "", body(code))
		if rr.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201; body = %s", rr.Code, rr.Body.String())
		}
	})
	t.Run("require_2fa true -> 403 before any credential is read", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		setSetting(t, database, "require_2fa", "true")
		rr := send(t, router, http.MethodPost, "/api/v1/auth/register", "", "", "", []byte(`{not json`))
		wantErr(t, rr, http.StatusForbidden, "FORBIDDEN", "registration is unavailable while two-factor authentication is required")
	})
	t.Run("registration closed -> 403 before any credential is read", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		setSetting(t, database, "registration_mode", "closed")
		rr := send(t, router, http.MethodPost, "/api/v1/auth/register", "", "", "", []byte(`{not json`))
		wantErr(t, rr, http.StatusForbidden, "FORBIDDEN", "registration is currently closed")
	})
	t.Run("user insert fails -> 500, invite not consumed", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		code := seedInvite(t, database)
		failWrite(t, database, "INSERT", "users")
		rr := send(t, router, http.MethodPost, "/api/v1/auth/register", "", "", "", body(code))
		wantErr(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR", "registration failed — please try again")
		if n := inviteUseCount(t, database, code); n != 0 {
			t.Errorf("invite use_count = %d, want 0 (transaction rolled back)", n)
		}
		if userByName(t, database, "fresh") != nil {
			t.Error("user row exists after a failed insert")
		}
	})
	t.Run("session insert fails -> 500, nothing committed", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		code := seedInvite(t, database)
		failWrite(t, database, "INSERT", "sessions")
		rr := send(t, router, http.MethodPost, "/api/v1/auth/register", "", "", "", body(code))
		// OC-0376 (fixed in B3-9): the first session is inserted inside the
		// registration transaction, so a store fault leaves no half-registered
		// account and does not burn the invite — the caller simply retries.
		if userByName(t, database, "fresh") != nil {
			t.Error("user row exists after the session insert failed")
		}
		if n := inviteUseCount(t, database, code); n != 0 {
			t.Errorf("invite use_count = %d, want 0 (transaction rolled back)", n)
		}
		wantErr(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR", "registration failed — please try again")
	})
}

// ─── Sentinel and failure-path mapping: /login ───────────────────────────────

func TestAuthCharacterization_LoginFailurePaths(t *testing.T) {
	login := func(t *testing.T, router http.Handler, password string) *httptest.ResponseRecorder {
		t.Helper()
		return send(t, router, http.MethodPost, "/api/v1/auth/login", "", "", "", map[string]string{"username": "target", "password": password})
	}
	t.Run("user lookup fails -> 500, no attempt recorded", func(t *testing.T) {
		database := newAuthTestDB(t)
		limiter := auth.NewRateLimiter()
		router := buildAuthRouter(database, limiter)
		seedUser(t, database, "target", "correctPass1", 4)
		hideTable(t, database, "users")
		rr := login(t, router, "correctPass1")
		wantErr(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR", "login temporarily unavailable")
		// Only the route's own per-IP window; the failure counters were not
		// touched, so an outage cannot lock anyone out.
		if w, l := limiter.Len(); w != 1 || l != 0 {
			t.Errorf("limiter state = %d windows / %d lockouts, want 1 / 0", w, l)
		}
	})
	t.Run("policy unreadable after a correct password -> 500", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		seedUser(t, database, "target", "correctPass1", 4)
		hideTable(t, database, "settings")
		rr := login(t, router, "correctPass1")
		wantErr(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to load authentication policy")
	})
	t.Run("policy unreadable with a wrong password -> 401 (credential guard runs first)", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		seedUser(t, database, "target", "correctPass1", 4)
		hideTable(t, database, "settings")
		rr := login(t, router, "wrongPass1")
		wantErr(t, rr, http.StatusUnauthorized, "UNAUTHORIZED", "invalid credentials")
	})
	t.Run("require_2fa unparsable -> 500", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		seedUser(t, database, "target", "correctPass1", 4)
		setSetting(t, database, "require_2fa", "yes")
		rr := login(t, router, "correctPass1")
		wantErr(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to load authentication policy")
	})
	t.Run("require_2fa parses case-insensitively with whitespace", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		seedUser(t, database, "target", "correctPass1", 4)
		setSetting(t, database, "require_2fa", " TRUE ")
		rr := login(t, router, "correctPass1")
		wantErr(t, rr, http.StatusForbidden, "FORBIDDEN", "two-factor authentication must be enabled on this account before login")
	})
	t.Run("require_2fa true and enrolled -> challenge, not 403", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		uid := seedUser(t, database, "target", "correctPass1", 4)
		enrolTOTP(t, database, uid)
		setSetting(t, database, "require_2fa", "true")
		loginPartial(t, router, "target", "correctPass1", "", "")
	})
	t.Run("session insert fails -> 500", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		seedUser(t, database, "target", "correctPass1", 4)
		failWrite(t, database, "INSERT", "sessions")
		rr := login(t, router, "correctPass1")
		wantErr(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create session")
	})
}

// ─── Session issue ───────────────────────────────────────────────────────────

func TestAuthCharacterization_SessionShape(t *testing.T) {
	hexToken := regexp.MustCompile(`^[0-9a-f]{64}$`)
	userKeys := []string{"about", "created_at", "custom_status", "display_name", "id", "role_id", "status", "totp_enabled", "username"}
	checkSuccess := func(t *testing.T, rr *httptest.ResponseRecorder, wantStatus int) string {
		t.Helper()
		if rr.Code != wantStatus {
			t.Fatalf("status = %d, want %d; body = %s", rr.Code, wantStatus, rr.Body.String())
		}
		var resp map[string]any
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		keys := slices.Sorted(maps.Keys(resp))
		if want := []string{"requires_2fa", "token", "user"}; !slices.Equal(keys, want) {
			t.Errorf("response keys = %v, want %v", keys, want)
		}
		token, _ := resp["token"].(string)
		if !hexToken.MatchString(token) {
			t.Errorf("token = %q, want 64 lowercase hex chars", token)
		}
		user, _ := resp["user"].(map[string]any)
		got := slices.Sorted(maps.Keys(user))
		if !slices.Equal(got, userKeys) {
			t.Errorf("user keys = %v, want %v (avatar omitted when empty; nullable fields present as null)", got, userKeys)
		}
		for _, k := range []string{"display_name", "about", "custom_status"} {
			if user[k] != nil {
				t.Errorf("user.%s = %v, want null when unset", k, user[k])
			}
		}
		return token
	}
	longUA := strings.Repeat("u", 600)

	t.Run("login issues one bearer session bound to device and IP", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		uid := seedUser(t, database, "shape", "correctPass1", 4)
		rr := send(t, router, http.MethodPost, "/api/v1/auth/login", "", "203.0.113.5", longUA, map[string]string{"username": "shape", "password": "correctPass1"})
		token := checkSuccess(t, rr, http.StatusOK)
		var n int
		if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, uid).Scan(&n); err != nil || n != 1 {
			t.Fatalf("session rows = %d (%v), want exactly one", n, err)
		}
		s, err := database.GetSessionByTokenHash(context.Background(), auth.HashToken(token))
		if err != nil || s == nil {
			t.Fatalf("session lookup by the issued token: %v", err)
		}
		if s.UserID != uid || s.IP != "203.0.113.5" || s.Device != longUA[:512] {
			t.Errorf("session = {user %d, ip %q, device len %d}, want {%d, 203.0.113.5, 512}", s.UserID, s.IP, len(s.Device), uid)
		}
		if me := send(t, router, http.MethodGet, "/api/v1/auth/me", token, "", "", nil); me.Code != http.StatusOK {
			t.Errorf("/me with the issued token = %d, want 200", me.Code)
		}
	})
	t.Run("register issues the same shape with 201", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		code := seedInvite(t, database)
		rr := send(t, router, http.MethodPost, "/api/v1/auth/register", "", "203.0.113.6", longUA,
			map[string]string{"username": "shape", "password": "securePass1", "invite_code": code})
		token := checkSuccess(t, rr, http.StatusCreated)
		s, err := database.GetSessionByTokenHash(context.Background(), auth.HashToken(token))
		if err != nil || s == nil {
			t.Fatalf("session lookup: %v", err)
		}
		if s.IP != "203.0.113.6" || s.Device != longUA[:512] {
			t.Errorf("session = {ip %q, device len %d}, want {203.0.113.6, 512}", s.IP, len(s.Device))
		}
	})
	t.Run("verify-totp binds the session to the login request, not the verify request", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		uid := seedUser(t, database, "shape", "correctPass1", 4)
		secret := enrolTOTP(t, database, uid)
		pt := loginPartial(t, router, "shape", "correctPass1", "198.51.100.7", "phone-ua")
		rr := send(t, router, http.MethodPost, "/api/v1/auth/verify-totp", pt, "203.0.113.9", "laptop-ua", map[string]string{"code": totpCode(t, secret)})
		token := checkSuccess(t, rr, http.StatusOK)
		s, err := database.GetSessionByTokenHash(context.Background(), auth.HashToken(token))
		if err != nil || s == nil {
			t.Fatalf("session lookup: %v", err)
		}
		if s.IP != "198.51.100.7" || s.Device != "phone-ua" {
			t.Errorf("session = {ip %q, device %q}, want the challenge's {198.51.100.7, phone-ua}", s.IP, s.Device)
		}
	})
}

// ─── Logout ──────────────────────────────────────────────────────────────────

func TestAuthCharacterization_Logout(t *testing.T) {
	custom := "in a meeting"
	setup := func(t *testing.T) (*db.DB, http.Handler, int64, string) {
		t.Helper()
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		uid := seedUser(t, database, "out", "correctPass1", 4)
		if err := database.UpdateUserCustomStatus(context.Background(), uid, &custom); err != nil {
			t.Fatalf("UpdateUserCustomStatus: %v", err)
		}
		return database, router, uid, seedSession(t, database, uid)
	}
	t.Run("clears the custom status", func(t *testing.T) {
		database, router, uid, token := setup(t)
		rr := send(t, router, http.MethodPost, "/api/v1/auth/logout", token, "", "", nil)
		if rr.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
		}
		u, _ := database.GetUserByID(context.Background(), uid)
		if u.CustomStatus != nil {
			t.Errorf("custom_status after logout = %q, want cleared", *u.CustomStatus)
		}
	})
	t.Run("session delete fails -> 500, session survives", func(t *testing.T) {
		database, router, _, token := setup(t)
		failWrite(t, database, "DELETE", "sessions")
		rr := send(t, router, http.MethodPost, "/api/v1/auth/logout", token, "", "", nil)
		wantErr(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to logout")
		if s, _ := database.GetSessionByTokenHash(context.Background(), auth.HashToken(token)); s == nil {
			t.Error("session gone although the delete was refused")
		}
	})
	t.Run("custom-status clear fails -> still 204, session revoked", func(t *testing.T) {
		database, router, uid, token := setup(t)
		failWrite(t, database, "UPDATE OF custom_status", "users")
		rr := send(t, router, http.MethodPost, "/api/v1/auth/logout", token, "", "", nil)
		if rr.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204 (status clear is best-effort); body = %s", rr.Code, rr.Body.String())
		}
		if s, _ := database.GetSessionByTokenHash(context.Background(), auth.HashToken(token)); s != nil {
			t.Error("session survived logout")
		}
		u, _ := database.GetUserByID(context.Background(), uid)
		if u.CustomStatus == nil || *u.CustomStatus != custom {
			t.Errorf("custom_status = %v, want unchanged %q (the clear was refused)", u.CustomStatus, custom)
		}
	})
}

// ─── Authenticated routes when the token cannot be resolved ──────────────────

// A database fault while resolving the bearer token is 503, never 401 — a
// 401 would make the client discard a valid session (AuthMiddleware's
// documented reason). Pinned per auth route so the slice cannot change it.
func TestAuthCharacterization_TokenResolutionFaultIs503(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildAuthRouter(database, auth.NewRateLimiter())
	uid := seedUser(t, database, "res", "correctPass1", 4)
	token := seedSession(t, database, uid)
	hideTable(t, database, "users")
	for name, req := range map[string]struct {
		method, path string
		body         any
	}{
		"GET /me":               {http.MethodGet, "/api/v1/auth/me", nil},
		"POST /logout":          {http.MethodPost, "/api/v1/auth/logout", nil},
		"DELETE /account":       {http.MethodDelete, "/api/v1/auth/account", map[string]string{"password": "correctPass1"}},
		"POST /totp/enable":     {http.MethodPost, "/api/v1/users/me/totp/enable", map[string]string{"password": "correctPass1"}},
		"POST /totp/confirm":    {http.MethodPost, "/api/v1/users/me/totp/confirm", map[string]string{"password": "correctPass1", "code": "000000"}},
		"DELETE /users/me/totp": {http.MethodDelete, "/api/v1/users/me/totp", map[string]string{"password": "correctPass1"}},
	} {
		rr := send(t, router, req.method, req.path, token, "", "", req.body)
		if rr.Code != http.StatusServiceUnavailable {
			t.Errorf("%s: status = %d, want 503; body = %s", name, rr.Code, rr.Body.String())
			continue
		}
		if e := decodeErr(t, rr); e.Error != "SERVICE_UNAVAILABLE" || e.Message != "authentication service temporarily unavailable" {
			t.Errorf("%s: body = %+v", name, e)
		}
	}
}

// ─── DELETE /account ─────────────────────────────────────────────────────────

func TestAuthCharacterization_DeleteAccountFailurePaths(t *testing.T) {
	t.Run("purge fails -> 500, account and session intact", func(t *testing.T) {
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		uid := seedUser(t, database, "gone", "correctPass1", 4)
		token := seedSession(t, database, uid)
		failWrite(t, database, "DELETE", "sessions")
		rr := send(t, router, http.MethodDelete, "/api/v1/auth/account", token, "", "", map[string]string{"password": "correctPass1"})
		wantErr(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to delete account")
		u, _ := database.GetUserByID(context.Background(), uid)
		if u == nil || u.Banned || u.Username != "gone" {
			t.Errorf("user after failed delete = %+v, want untouched", u)
		}
		if me := send(t, router, http.MethodGet, "/api/v1/auth/me", token, "", "", nil); me.Code != http.StatusOK {
			t.Errorf("/me after failed delete = %d, want 200 (session must survive the rolled-back transaction)", me.Code)
		}
	})
	t.Run("malformed body -> 400 before the password is checked", func(t *testing.T) {
		database := newAuthTestDB(t)
		limiter := auth.NewRateLimiter()
		router := buildAuthRouter(database, limiter)
		uid := seedUser(t, database, "gone", "correctPass1", 4)
		token := seedSession(t, database, uid)
		rr := send(t, router, http.MethodDelete, "/api/v1/auth/account", token, "", "", []byte(`{not json`))
		wantErr(t, rr, http.StatusBadRequest, "INVALID_INPUT", "malformed request body")
		// Route window only — a malformed body is not a failed attempt.
		if w, l := limiter.Len(); w != 1 || l != 0 {
			t.Errorf("limiter state = %d windows / %d lockouts, want 1 / 0", w, l)
		}
	})
	t.Run("wrong password -> 400 incorrect password, counted", func(t *testing.T) {
		database := newAuthTestDB(t)
		limiter := auth.NewRateLimiter()
		router := buildAuthRouter(database, limiter)
		uid := seedUser(t, database, "gone", "correctPass1", 4)
		token := seedSession(t, database, uid)
		rr := send(t, router, http.MethodDelete, "/api/v1/auth/account", token, "", "", map[string]string{"password": "wrongPass1"})
		wantErr(t, rr, http.StatusBadRequest, "INVALID_INPUT", "incorrect password")
		if w, _ := limiter.Len(); w != 2 {
			t.Errorf("limiter windows = %d, want 2 (route + delete_fail)", w)
		}
	})
}

// ─── POST /verify-totp ───────────────────────────────────────────────────────

func TestAuthCharacterization_VerifyTOTPFailurePaths(t *testing.T) {
	setup := func(t *testing.T) (*db.DB, http.Handler, int64, string) {
		t.Helper()
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		uid := seedUser(t, database, "two", "correctPass1", 4)
		secret := enrolTOTP(t, database, uid)
		return database, router, uid, secret
	}
	verify := func(t *testing.T, router http.Handler, pt, code, ip string) *httptest.ResponseRecorder {
		t.Helper()
		return send(t, router, http.MethodPost, "/api/v1/auth/verify-totp", pt, ip, "", map[string]string{"code": code})
	}
	const challengeGone = "invalid or expired two-factor challenge"

	t.Run("user lookup fails -> 500, challenge kept, attempt not counted", func(t *testing.T) {
		database, router, _, secret := setup(t)
		pt := loginPartial(t, router, "two", "correctPass1", "", "")
		hideTable(t, database, "users")
		// OC-0377 (fixed in B3-9): a store fault while loading the challenged
		// user is an outage, not a bad challenge — 5xx, the challenge stays
		// live, and the attempt is not charged to the per-user totp_fail cap.
		wantErr(t, verify(t, router, pt, totpCode(t, secret), ""), http.StatusInternalServerError, "INTERNAL_ERROR", "two-factor verification temporarily unavailable")
		if _, err := database.ExecContext(context.Background(), `ALTER TABLE users_gone RENAME TO users`); err != nil {
			t.Fatalf("restore users: %v", err)
		}
		// The cap is 10 per user: ten wrong codes must all still answer 401
		// "invalid two-factor code" — had the faulted attempt counted, the
		// tenth would be the 429. The first five ride the surviving challenge
		// (which proves it was kept), the next five a fresh one.
		attempt := 0
		for _, token := range []string{pt, loginPartial(t, router, "two", "correctPass1", "", "")} {
			for range 5 {
				attempt++
				wantErr(t, verify(t, router, token, wrongTOTPCode(t, secret), fmt.Sprintf("203.0.113.%d", attempt)), http.StatusUnauthorized, "UNAUTHORIZED", "invalid two-factor code")
			}
		}
		// Negative control: the counter is live — the eleventh attempt is refused.
		pt = loginPartial(t, router, "two", "correctPass1", "", "")
		wantErr(t, verify(t, router, pt, totpCode(t, secret), "203.0.113.99"), http.StatusTooManyRequests, "RATE_LIMITED", "too many failed attempts, try again later")
	})
	t.Run("secret removed after the challenge was issued -> 401", func(t *testing.T) {
		database, router, uid, secret := setup(t)
		pt := loginPartial(t, router, "two", "correctPass1", "", "")
		if err := database.UpdateUserTOTPSecret(context.Background(), uid, nil); err != nil {
			t.Fatalf("clear secret: %v", err)
		}
		wantErr(t, verify(t, router, pt, totpCode(t, secret), ""), http.StatusUnauthorized, "UNAUTHORIZED", challengeGone)
	})
	t.Run("secret encrypted under another key -> 500", func(t *testing.T) {
		database, router, uid, secret := setup(t)
		pt := loginPartial(t, router, "two", "correctPass1", "", "")
		otherKey := bytes.Repeat([]byte{7}, 32)
		enc, err := auth.EncryptTOTPSecret(otherKey, secret)
		if err != nil {
			t.Fatalf("EncryptTOTPSecret: %v", err)
		}
		if err := database.UpdateUserTOTPSecret(context.Background(), uid, &enc); err != nil {
			t.Fatalf("store foreign secret: %v", err)
		}
		wantErr(t, verify(t, router, pt, totpCode(t, secret), ""), http.StatusInternalServerError, "INTERNAL_ERROR", "failed to verify two-factor code")
	})
	t.Run("session insert fails -> 500, the challenge and the code survive", func(t *testing.T) {
		database, router, _, secret := setup(t)
		pt := loginPartial(t, router, "two", "correctPass1", "", "")
		failWrite(t, database, "INSERT", "sessions")
		code := totpCode(t, secret)
		wantErr(t, verify(t, router, pt, code, ""), http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create session")
		// OC-0378 (fixed in B3-9): the verified second factor is not discarded
		// by a store fault — the challenge is restored under the same partial
		// token and the accepted code is released, so once the store is back
		// the same token and the same code complete the login. (Restore alone
		// would refuse the retry as a replay.)
		if _, err := database.ExecContext(context.Background(), `DROP TRIGGER fault_insert_sessions`); err != nil {
			t.Fatalf("drop trigger: %v", err)
		}
		rr := verify(t, router, pt, code, "203.0.113.2")
		if rr.Code != http.StatusOK {
			t.Fatalf("retry status = %d, want 200; body = %s", rr.Code, rr.Body.String())
		}
		var res struct {
			Token       string `json:"token"`
			Requires2FA bool   `json:"requires_2fa"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &res); err != nil || res.Token == "" || res.Requires2FA {
			t.Fatalf("retry body = %s (err %v), want a session token", rr.Body.String(), err)
		}
	})
	t.Run("per-user failure cap spans challenges -> 429 on the 11th attempt", func(t *testing.T) {
		_, router, _, secret := setup(t)
		attempt := 0
		for range 2 {
			pt := loginPartial(t, router, "two", "correctPass1", "", "")
			// partialAuthMaxFailures (5) consumes the challenge; the per-user
			// totp_fail counter (10) keeps counting across challenges.
			for range 5 {
				attempt++
				rr := verify(t, router, pt, wrongTOTPCode(t, secret), fmt.Sprintf("203.0.113.%d", attempt))
				wantErr(t, rr, http.StatusUnauthorized, "UNAUTHORIZED", "invalid two-factor code")
			}
		}
		pt := loginPartial(t, router, "two", "correctPass1", "", "")
		rr := verify(t, router, pt, totpCode(t, secret), "203.0.113.99")
		wantErr(t, rr, http.StatusTooManyRequests, "RATE_LIMITED", "too many failed attempts, try again later")
	})
}

// ─── TOTP management: /enable, /confirm, DELETE /users/me/totp ───────────────

func TestAuthCharacterization_TOTPManagementFailurePaths(t *testing.T) {
	setup := func(t *testing.T) (*db.DB, http.Handler, int64, string) {
		t.Helper()
		database := newAuthTestDB(t)
		router := buildAuthRouter(database, auth.NewRateLimiter())
		uid := seedUser(t, database, "mgmt", "correctPass1", 4)
		return database, router, uid, seedSession(t, database, uid)
	}
	pw := map[string]string{"password": "correctPass1"}

	t.Run("enable while enrolled -> 409", func(t *testing.T) {
		database, router, uid, token := setup(t)
		enrolTOTP(t, database, uid)
		rr := send(t, router, http.MethodPost, "/api/v1/users/me/totp/enable", token, "", "", pw)
		wantErr(t, rr, http.StatusConflict, "TOTP_ALREADY_ENABLED", "disable 2FA before re-enabling")
	})
	t.Run("enable with malformed body -> 400", func(t *testing.T) {
		_, router, _, token := setup(t)
		rr := send(t, router, http.MethodPost, "/api/v1/users/me/totp/enable", token, "", "", []byte(`{not json`))
		wantErr(t, rr, http.StatusBadRequest, "INVALID_INPUT", "malformed request body")
	})
	t.Run("enable with empty password -> 400 password is required", func(t *testing.T) {
		_, router, _, token := setup(t)
		rr := send(t, router, http.MethodPost, "/api/v1/users/me/totp/enable", token, "", "", map[string]string{})
		wantErr(t, rr, http.StatusBadRequest, "INVALID_INPUT", "password is required")
	})
	t.Run("password-confirmation lockout is shared by enable, confirm and disable", func(t *testing.T) {
		_, router, _, token := setup(t)
		// pwConfirmFailureThreshold (3) failures are recorded; the 4th trips
		// the lockout while still answering 400. Distinct IPs keep the shared
		// "totp:" route window (5/min per IP) out of the picture.
		for i := range 4 {
			rr := send(t, router, http.MethodPost, "/api/v1/users/me/totp/enable", token, fmt.Sprintf("203.0.113.%d", i+1), "", map[string]string{"password": "wrongPass1"})
			wantErr(t, rr, http.StatusBadRequest, "INVALID_INPUT", "password confirmation failed")
		}
		const locked = "too many failed attempts, try again later"
		wantErr(t, send(t, router, http.MethodPost, "/api/v1/users/me/totp/enable", token, "203.0.113.11", "", pw), http.StatusTooManyRequests, "RATE_LIMITED", locked)
		wantErr(t, send(t, router, http.MethodPost, "/api/v1/users/me/totp/confirm", token, "203.0.113.12", "", map[string]string{"password": "correctPass1", "code": "000000"}), http.StatusTooManyRequests, "RATE_LIMITED", locked)
		wantErr(t, send(t, router, http.MethodDelete, "/api/v1/users/me/totp", token, "203.0.113.13", "", pw), http.StatusTooManyRequests, "RATE_LIMITED", locked)
	})
	t.Run("confirm: secret persist fails -> 500, nothing enrolled", func(t *testing.T) {
		database, router, uid, token := setup(t)
		rr := send(t, router, http.MethodPost, "/api/v1/users/me/totp/enable", token, "", "", pw)
		if rr.Code != http.StatusOK {
			t.Fatalf("enable: %d %s", rr.Code, rr.Body.String())
		}
		var enable map[string]any
		_ = json.Unmarshal(rr.Body.Bytes(), &enable)
		secret := extractSecretFromURI(t, enable["qr_uri"].(string))
		failWrite(t, database, "UPDATE OF totp_secret", "users")
		rr = send(t, router, http.MethodPost, "/api/v1/users/me/totp/confirm", token, "", "", map[string]string{"password": "correctPass1", "code": totpCode(t, secret)})
		wantErr(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to enable two-factor authentication")
		if u, _ := database.GetUserByID(context.Background(), uid); u.TOTPSecret != nil {
			t.Error("secret persisted although the update was refused")
		}
	})
	t.Run("confirm with malformed body -> 400", func(t *testing.T) {
		_, router, _, token := setup(t)
		rr := send(t, router, http.MethodPost, "/api/v1/users/me/totp/confirm", token, "", "", []byte(`{not json`))
		wantErr(t, rr, http.StatusBadRequest, "INVALID_INPUT", "malformed request body")
	})
	t.Run("disable: policy unreadable -> 500, still enrolled", func(t *testing.T) {
		database, router, uid, token := setup(t)
		enrolTOTP(t, database, uid)
		hideTable(t, database, "settings")
		rr := send(t, router, http.MethodDelete, "/api/v1/users/me/totp", token, "", "", pw)
		wantErr(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to load authentication policy")
		if u, _ := database.GetUserByID(context.Background(), uid); u.TOTPSecret == nil {
			t.Error("secret cleared although the policy read failed")
		}
	})
	t.Run("disable: secret clear fails -> 500, still enrolled", func(t *testing.T) {
		database, router, uid, token := setup(t)
		enrolTOTP(t, database, uid)
		failWrite(t, database, "UPDATE OF totp_secret", "users")
		rr := send(t, router, http.MethodDelete, "/api/v1/users/me/totp", token, "", "", pw)
		wantErr(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to disable two-factor authentication")
		if u, _ := database.GetUserByID(context.Background(), uid); u.TOTPSecret == nil {
			t.Error("secret cleared although the update was refused")
		}
	})
	t.Run("disable when not enrolled -> 204 (idempotent)", func(t *testing.T) {
		_, router, _, token := setup(t)
		rr := send(t, router, http.MethodDelete, "/api/v1/users/me/totp", token, "", "", pw)
		if rr.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
		}
	})
	t.Run("disable with an empty body -> 400 password is required", func(t *testing.T) {
		_, router, _, token := setup(t)
		rr := send(t, router, http.MethodDelete, "/api/v1/users/me/totp", token, "", "", nil)
		wantErr(t, rr, http.StatusBadRequest, "INVALID_INPUT", "password is required")
	})
	t.Run("disable with a malformed body -> 400", func(t *testing.T) {
		_, router, _, token := setup(t)
		rr := send(t, router, http.MethodDelete, "/api/v1/users/me/totp", token, "", "", []byte(`{not json`))
		wantErr(t, rr, http.StatusBadRequest, "INVALID_INPUT", "malformed request body")
	})
}

// ─── Route-level rate limits ─────────────────────────────────────────────────

// The per-IP RateLimitMiddleware on each auth route: N requests per minute
// pass, the N+1th is 429 with Retry-After, regardless of the credentials.
func TestAuthCharacterization_RouteRateLimits(t *testing.T) {
	const slowDown = "too many requests, please slow down"
	rows := []struct {
		name   string
		limit  int
		setup  func(t *testing.T, database *db.DB) (token string)
		method string
		path   string
		body   any
		want   int // status of the requests inside the limit
	}{
		{"login 5/min", 5, func(*testing.T, *db.DB) string { return "" },
			http.MethodPost, "/api/v1/auth/login", map[string]string{"username": "nobody", "password": "wrongPass1"}, http.StatusUnauthorized},
		{"verify-totp 10/min", 10, func(*testing.T, *db.DB) string { return "bogus" },
			http.MethodPost, "/api/v1/auth/verify-totp", map[string]string{"code": "000000"}, http.StatusUnauthorized},
		{"delete account 5/min", 5, func(t *testing.T, d *db.DB) string { return seedSession(t, d, seedUser(t, d, "rl", "correctPass1", 4)) },
			http.MethodDelete, "/api/v1/auth/account", map[string]string{}, http.StatusBadRequest},
		{"totp management 5/min shared across the three routes", 5, func(t *testing.T, d *db.DB) string { return seedSession(t, d, seedUser(t, d, "rl", "correctPass1", 4)) },
			http.MethodPost, "/api/v1/users/me/totp/enable", []byte(`{not json`), http.StatusBadRequest},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			database := newAuthTestDB(t)
			router := buildAuthRouter(database, auth.NewRateLimiter())
			token := row.setup(t, database)
			for i := range row.limit {
				if rr := send(t, router, row.method, row.path, token, "", "", row.body); rr.Code != row.want {
					t.Fatalf("request %d: status = %d, want %d; body = %s", i+1, rr.Code, row.want, rr.Body.String())
				}
			}
			path := row.path
			if strings.Contains(path, "/totp/enable") {
				path = "/api/v1/users/me/totp/confirm" // the sibling shares the "totp:" window
			}
			rr := send(t, router, row.method, path, token, "", "", row.body)
			wantErr(t, rr, http.StatusTooManyRequests, "RATE_LIMITED", slowDown)
			if ra := rr.Header().Get("Retry-After"); ra != "60" {
				t.Errorf("Retry-After = %q, want 60", ra)
			}
		})
	}
}
