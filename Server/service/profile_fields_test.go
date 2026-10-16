package service

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Phase 6 profile fields. The rules that matter here are the ones a handler
// could plausibly skip: sanitization, the length bounds, "omitted means
// unchanged", and "empty means cleared". They live in the service precisely so
// every transport gets them, so they are tested against the service.

func newUserSvc(t *testing.T) (*UserService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
	return NewUserService(database), database
}

func TestUpdateProfile_SetsAndClearsDisplayNameAndAbout(t *testing.T) {
	svc, _ := newUserSvc(t)
	ctx := context.Background()

	name, about := "Ada L.", "counts on it"
	u, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", DisplayName: &name, About: &about})
	if err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if u.DisplayName == nil || *u.DisplayName != name {
		t.Fatalf("display_name = %v, want %q", u.DisplayName, name)
	}
	if u.About == nil || *u.About != about {
		t.Fatalf("about = %v, want %q", u.About, about)
	}

	// A patch that mentions neither field must leave both standing — the
	// update writes every column, so this is the merge doing its job.
	u, err = svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada"})
	if err != nil {
		t.Fatalf("UpdateProfile (username only): %v", err)
	}
	if u.DisplayName == nil || u.About == nil {
		t.Fatalf("a username-only patch cleared other fields: %v / %v", u.DisplayName, u.About)
	}

	// An explicit empty string clears.
	empty := ""
	u, err = svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", DisplayName: &empty, About: &empty})
	if err != nil {
		t.Fatalf("UpdateProfile (clear): %v", err)
	}
	if u.DisplayName != nil || u.About != nil {
		t.Fatalf("expected cleared, got %v / %v", u.DisplayName, u.About)
	}
}

// raceDetectingStore wraps a real Store and records whether two GetUserByID
// calls were ever in flight at once, to prove UpdateProfile's read-merge-
// write serializes per user rather than merely happening to avoid a race
// under a particular timing.
type raceDetectingStore struct {
	Store
	active  atomic.Int32
	overlap atomic.Int32
}

func (r *raceDetectingStore) GetUserByID(ctx context.Context, id int64) (*db.User, error) {
	if r.active.Add(1) > 1 {
		r.overlap.Add(1)
	}
	time.Sleep(5 * time.Millisecond) // widen the window a real race would need
	defer r.active.Add(-1)
	return r.Store.GetUserByID(ctx, id)
}

func TestUpdateProfile_ConcurrentUpdatesSerializePerUser(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
	rs := &raceDetectingStore{Store: database}
	svc := NewUserService(rs)
	ctx := context.Background()

	// Simulates PATCH /users/me (sets display_name) racing
	// POST /users/me/avatar (sets about, standing in for the avatar column;
	// both calls pass the unrelated field's current value the way the real
	// handlers do). Without serialization, whichever call's read lands
	// between the other's read and write would revert that other call's
	// change when it writes its own stale merge.
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		name := "Ada L."
		if _, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", DisplayName: &name}); err != nil {
			t.Errorf("UpdateProfile (display_name): %v", err)
		}
	}()
	go func() {
		defer wg.Done()
		about := "counts on it"
		if _, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", About: &about}); err != nil {
			t.Errorf("UpdateProfile (about): %v", err)
		}
	}()
	wg.Wait()

	if got := rs.overlap.Load(); got != 0 {
		t.Errorf("UpdateProfile's read-merge-write overlapped %d times, want 0 (must be serialized per user)", got)
	}

	u, err := database.GetUserByID(ctx, 1)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if u.DisplayName == nil || *u.DisplayName != "Ada L." {
		t.Errorf("display_name = %v, want %q — must not be reverted by a concurrent update", u.DisplayName, "Ada L.")
	}
	if u.About == nil || *u.About != "counts on it" {
		t.Errorf("about = %v, want %q — must not be reverted by a concurrent update", u.About, "counts on it")
	}
}

// OC-0102: an avatar-only patch must not carry a username at all, so a stale
// pre-lock snapshot (handleUploadAvatar captures user.Username before the
// multipart parse / image decode / disk write, well before this function's
// per-user lock) can never overwrite a rename that commits in the meantime.
// UpdateProfile's read-merge-write already treats DisplayName/About this
// way (nil-vs-non-nil pointer); Username needs the same "unspecified means
// leave it alone" contract via its own zero value, since it is a plain
// string rather than a pointer.
func TestUpdateProfile_AvatarOnlyPatchDoesNotOverwriteUsername(t *testing.T) {
	svc, database := newUserSvc(t)
	ctx := context.Background()

	// Models a concurrent PATCH /users/me rename that lands and commits
	// first.
	if _, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "bob"}); err != nil {
		t.Fatalf("rename UpdateProfile: %v", err)
	}

	// An avatar-only caller supplies no username intent at all — Username is
	// left at its zero value, the way handleUploadAvatar's ProfilePatch must
	// after the fix (it no longer fills Username from its stale snapshot).
	avatarURL := "/api/v1/files/abc"
	u, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Avatar: &avatarURL})
	if err != nil {
		t.Fatalf("avatar-only UpdateProfile: %v", err)
	}
	if u.Username != "bob" {
		t.Fatalf("username = %q, want %q — an avatar-only patch must not revert a concurrent rename", u.Username, "bob")
	}
	if u.Avatar == nil || *u.Avatar != avatarURL {
		t.Fatalf("avatar = %v, want %q — the avatar itself must still be applied", u.Avatar, avatarURL)
	}

	stored, err := database.GetUserByID(ctx, 1)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if stored.Username != "bob" {
		t.Fatalf("stored username = %q, want %q", stored.Username, "bob")
	}
}

func TestUpdateProfile_SanitizesAndTrims(t *testing.T) {
	svc, _ := newUserSvc(t)
	name := "  <b>Ada</b>  "
	about := "<script>alert(1)</script>hello"
	u, err := svc.UpdateProfile(context.Background(), 1, ProfilePatch{
		Username: "ada", DisplayName: &name, About: &about,
	})
	if err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if u.DisplayName == nil || *u.DisplayName != "Ada" {
		t.Errorf("display_name = %v, want %q", u.DisplayName, "Ada")
	}
	if u.About == nil || strings.Contains(*u.About, "<") {
		t.Errorf("about = %v, want markup stripped", u.About)
	}
}

func TestUpdateProfile_RejectsOverlongFields(t *testing.T) {
	svc, _ := newUserSvc(t)
	ctx := context.Background()

	tooLongName := strings.Repeat("a", MaxDisplayNameLen+1)
	if _, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", DisplayName: &tooLongName}); !errors.Is(err, ErrBadRequest) {
		t.Errorf("overlong display_name err = %v, want ErrBadRequest", err)
	}
	tooLongAbout := strings.Repeat("b", MaxAboutLen+1)
	if _, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", About: &tooLongAbout}); !errors.Is(err, ErrBadRequest) {
		t.Errorf("overlong about err = %v, want ErrBadRequest", err)
	}

	// Exactly at the bound is accepted, and the bound counts runes rather than
	// bytes — otherwise a name in a non-Latin script would be a third as long.
	atBound := strings.Repeat("\u00e9", MaxDisplayNameLen)
	if _, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", DisplayName: &atBound}); err != nil {
		t.Errorf("display_name at bound rejected: %v", err)
	}
}

// OC-0192: UpdateProfile is the one function every transport (the REST
// handler, and any future non-REST caller — see ProfilePatch's doc comment)
// goes through, so the raw-length bound belongs here, not only in the
// handler. cleanText (sanitizeToFixpoint) is quadratic in input length, and
// nothing bounds DisplayName/About before line 140/143 run it — the rune-
// count checks there run cleanText's full (expensive) output before ever
// looking at how long it is. A caller that hands UpdateProfile an
// adversarial nested-entity payload must be rejected on a cheap byte-length
// check, not after the fixpoint sanitizer has already paid its cost on it.
func TestUpdateProfile_OversizedDisplayNameAndAboutRejectedBeforeSanitizing(t *testing.T) {
	svc, _ := newUserSvc(t)
	ctx := context.Background()

	// Adversarial nested-entity payload (16 KB) — see sanitizeToFixpoint's
	// doc comment (message.go) for why this shape is quadratic to sanitize.
	huge := "&" + strings.Repeat("amp;", 4000) + "lt;"

	start := time.Now()
	_, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", DisplayName: &huge})
	elapsed := time.Since(start)
	if !errors.Is(err, ErrBadRequest) {
		t.Errorf("oversized display_name err = %v, want ErrBadRequest", err)
	}
	// A guard that runs before sanitizing rejects in well under a
	// millisecond; the pre-fix code spends well over 150ms in
	// sanitizeToFixpoint on this payload before the rune-count check ever
	// runs. 150ms gives generous margin over noise while staying far below
	// the unguarded cost.
	if elapsed > 150*time.Millisecond {
		t.Errorf("oversized display_name took %v, want well under 150ms (raw field must be bounded before sanitizing)", elapsed)
	}

	start = time.Now()
	_, err = svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", About: &huge})
	elapsed = time.Since(start)
	if !errors.Is(err, ErrBadRequest) {
		t.Errorf("oversized about err = %v, want ErrBadRequest", err)
	}
	if elapsed > 150*time.Millisecond {
		t.Errorf("oversized about took %v, want well under 150ms (raw field must be bounded before sanitizing)", elapsed)
	}
}

func TestSetCustomStatus_RoundTripClearAndBound(t *testing.T) {
	svc, database := newUserSvc(t)
	ctx := context.Background()

	if err := svc.SetCustomStatus(ctx, 1, "  <i>debugging</i>  "); err != nil {
		t.Fatalf("SetCustomStatus: %v", err)
	}
	u, _ := database.GetUserByID(ctx, 1)
	if u.CustomStatus == nil || *u.CustomStatus != "debugging" {
		t.Fatalf("custom_status = %v, want sanitized+trimmed %q", u.CustomStatus, "debugging")
	}

	if err := svc.SetCustomStatus(ctx, 1, "   "); err != nil {
		t.Fatalf("SetCustomStatus (blank): %v", err)
	}
	u, _ = database.GetUserByID(ctx, 1)
	if u.CustomStatus != nil {
		t.Fatalf("whitespace-only text should clear, got %q", *u.CustomStatus)
	}

	if err := svc.SetCustomStatus(ctx, 1, strings.Repeat("x", MaxCustomStatusLen+1)); !errors.Is(err, ErrBadRequest) {
		t.Errorf("overlong custom_status err = %v, want ErrBadRequest", err)
	}
}

func TestClearCustomStatus(t *testing.T) {
	svc, database := newUserSvc(t)
	ctx := context.Background()
	if err := svc.SetCustomStatus(ctx, 1, "afk"); err != nil {
		t.Fatalf("SetCustomStatus: %v", err)
	}
	if err := svc.ClearCustomStatus(ctx, 1); err != nil {
		t.Fatalf("ClearCustomStatus: %v", err)
	}
	u, _ := database.GetUserByID(ctx, 1)
	if u.CustomStatus != nil {
		t.Fatalf("custom_status = %q, want nil", *u.CustomStatus)
	}
}

func TestAvatarFileURL(t *testing.T) {
	if got := AvatarFileURL("abc"); got != "/api/v1/files/abc" {
		t.Errorf("AvatarFileURL = %q", got)
	}
}

func TestHandlePresenceUpdate_AcceptsInvisibleAndCarriesCustomStatus(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))
	ctx := context.Background()

	text := "  <b>away</b>  "
	res, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusInvisible, &text, nil, nil)
	got := res.CustomStatus
	if err != nil {
		t.Fatalf("HandlePresenceUpdate: %v", err)
	}
	if got == nil || *got != "away" {
		t.Fatalf("returned custom status = %v, want sanitized %q", got, "away")
	}
	u, _ := database.GetUserByID(ctx, 1)
	// Stored as chosen — the invisible -> offline collapse is a broadcast-time
	// concern, and storing it collapsed would make the next connect unable to
	// tell "appear offline" from "not connected".
	if u.Status != db.StatusInvisible {
		t.Fatalf("stored status = %q, want invisible", u.Status)
	}

	// A later status flip that carries no custom_status field must leave the
	// text alone AND still put it on the wire, or the auto-idle timer would
	// blank everyone else's copy several times an hour.
	res, err = svc.HandlePresenceUpdate(ctx, 1, db.StatusIdle, nil, nil, nil)
	got = res.CustomStatus
	if err != nil {
		t.Fatalf("HandlePresenceUpdate (bare): %v", err)
	}
	if got == nil || *got != "away" {
		t.Fatalf("bare status flip returned %v, want the stored %q", got, "away")
	}
	u, _ = database.GetUserByID(ctx, 1)
	if u.CustomStatus == nil || *u.CustomStatus != "away" {
		t.Fatalf("bare status flip changed the stored text: %v", u.CustomStatus)
	}
}

// OC-0195: same defect as OC-0192 (TestUpdateProfile_OversizedDisplayNameAndAboutRejectedBeforeSanitizing)
// but reached over presence_update instead of PATCH /users/me. HandlePresenceUpdate
// applied MaxCustomStatusLen to cleanText's *output*, so an adversarial
// nested-entity payload paid the full quadratic sanitizeToFixpoint cost before
// ever being measured. The WS read limit (config.MaxMessageBytes, 1 MiB) admits
// a payload here far larger than PATCH /users/me's body ever could, and this
// runs on the connection's own readPump goroutine.
func TestHandlePresenceUpdate_OversizedCustomStatusRejectedBeforeSanitizing(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))
	ctx := context.Background()

	// Adversarial nested-entity payload (16 KB) — see sanitizeToFixpoint's
	// doc comment (message.go) for why this shape is quadratic to sanitize.
	huge := "&" + strings.Repeat("amp;", 4000) + "lt;"

	start := time.Now()
	_, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusOnline, &huge, nil, nil)
	elapsed := time.Since(start)
	if !errors.Is(err, ErrBadRequest) {
		t.Errorf("oversized custom_status err = %v, want ErrBadRequest", err)
	}
	// A guard that runs before sanitizing rejects in well under a
	// millisecond; the pre-fix code spends well over 150ms in
	// sanitizeToFixpoint on this payload before the rune-count check ever
	// runs. 150ms gives generous margin over noise while staying far below
	// the unguarded cost.
	if elapsed > 150*time.Millisecond {
		t.Errorf("oversized custom_status took %v, want well under 150ms (raw field must be bounded before sanitizing)", elapsed)
	}
	// The rejected call must not have committed the status either.
	u, _ := database.GetUserByID(ctx, 1)
	if u.Status == db.StatusOnline {
		t.Error("a rejected presence_update must not commit the status")
	}
}

func TestHandlePresenceUpdate_RejectsUnknownStatusAndOverlongText(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))
	ctx := context.Background()

	if _, err := svc.HandlePresenceUpdate(ctx, 1, "afk", nil, nil, nil); !errors.Is(err, ErrBadRequest) {
		t.Errorf("unknown status err = %v, want ErrBadRequest", err)
	}
	long := strings.Repeat("x", MaxCustomStatusLen+1)
	if _, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusOnline, &long, nil, nil); !errors.Is(err, ErrBadRequest) {
		t.Errorf("overlong custom_status err = %v, want ErrBadRequest", err)
	}
	// The rejected call must not have committed the status either.
	u, _ := database.GetUserByID(ctx, 1)
	if u.Status == db.StatusOnline {
		t.Error("a rejected presence_update must not commit the status")
	}
}

// ─── WP 3C-9: character rules for single-line visible text ──────────────────

// visibleTextCases are the inputs every single-line field treats alike. ok
// cases must also round-trip to want.
var visibleTextCases = []struct {
	name string
	in   string
	ok   bool
	want string
}{
	{"newline", "a\nb", false, ""},
	{"tab", "a\tb", false, ""},
	{"bidi override", "a\u202eb", false, ""},
	{"entity bidi override", "a&#x202e;b", false, ""},
	{"line separator", "a\u2028b", false, ""},
	{"entity line separator", "a&#x2028;b", false, ""},
	{"paragraph separator", "a\u2029b", false, ""},
	{"hangul filler", "a\u3164b", false, ""},
	{"heart emoji selector", "\u2764\ufe0f", true, "\u2764\ufe0f"},
	{"heart fire", "\u2764\ufe0f\u200d\U0001F525", true, "\u2764\ufe0f\u200d\U0001F525"},
	{"zero width space", "a\u200bb", false, ""},
	{"zalgo three marks", "e\u0301\u0302\u0303", false, ""},
	{"zwj between letters", "a\u200db", false, ""},
	{"two marks", "e\u0301\u0302", true, "e\u0301\u0302"},
	{"emoji family", "\U0001F468\u200d\U0001F469\u200d\U0001F467", true, "\U0001F468\u200d\U0001F469\u200d\U0001F467"},
	{"nfc e-acute", "caf\u00e9", true, "caf\u00e9"},
	{"nfd e-acute", "cafe\u0301", true, "cafe\u0301"},
	{"spaces collapse", "a    b \u00a0 c", true, "a b c"},
}

func TestSetCustomStatus_CharacterRules(t *testing.T) {
	for _, tc := range visibleTextCases {
		t.Run(tc.name, func(t *testing.T) {
			svc, database := newUserSvc(t)
			ctx := context.Background()
			err := svc.SetCustomStatus(ctx, 1, tc.in)
			if !tc.ok {
				if !errors.Is(err, ErrBadRequest) {
					t.Fatalf("SetCustomStatus(%q) = %v, want ErrBadRequest", tc.in, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("SetCustomStatus(%q): %v", tc.in, err)
			}
			u, _ := database.GetUserByID(ctx, 1)
			if u.CustomStatus == nil || *u.CustomStatus != tc.want {
				t.Fatalf("stored custom_status = %v, want %q", u.CustomStatus, tc.want)
			}
		})
	}
}

func TestHandlePresenceUpdate_CustomStatusCharacterRules(t *testing.T) {
	for _, tc := range visibleTextCases {
		t.Run(tc.name, func(t *testing.T) {
			database := newTestDB(t)
			seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
			svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))
			in := tc.in
			res, err := svc.HandlePresenceUpdate(context.Background(), 1, db.StatusOnline, &in, nil, nil)
			if !tc.ok {
				if !errors.Is(err, ErrBadRequest) {
					t.Fatalf("HandlePresenceUpdate(%q) = %v, want ErrBadRequest", tc.in, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("HandlePresenceUpdate(%q): %v", tc.in, err)
			}
			if res.CustomStatus == nil || *res.CustomStatus != tc.want {
				t.Fatalf("returned custom status = %v, want %q", res.CustomStatus, tc.want)
			}
		})
	}
}

func TestUpdateProfile_DisplayNameCharacterRules(t *testing.T) {
	for _, tc := range visibleTextCases {
		t.Run(tc.name, func(t *testing.T) {
			svc, _ := newUserSvc(t)
			in := tc.in
			u, err := svc.UpdateProfile(context.Background(), 1, ProfilePatch{Username: "ada", DisplayName: &in})
			if !tc.ok {
				if !errors.Is(err, ErrBadRequest) {
					t.Fatalf("UpdateProfile(display_name=%q) = %v, want ErrBadRequest", tc.in, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("UpdateProfile(display_name=%q): %v", tc.in, err)
			}
			if u.DisplayName == nil || *u.DisplayName != tc.want {
				t.Fatalf("display_name = %v, want %q", u.DisplayName, tc.want)
			}
		})
	}
}

// The rune cap counts the collapsed text: a status that is over the cap only
// because of repeated spaces fits, and one that is over it after collapsing
// does not.
func TestVisibleText_CapCountsAfterCollapse(t *testing.T) {
	svc, database := newUserSvc(t)
	ctx := context.Background()

	spaced := strings.Repeat("x"+strings.Repeat(" ", 5), MaxCustomStatusLen/2) // far over the cap raw
	if len([]rune(spaced)) <= MaxCustomStatusLen {
		t.Fatalf("test input must exceed the cap before collapsing, has %d runes", len([]rune(spaced)))
	}
	if err := svc.SetCustomStatus(ctx, 1, spaced); err != nil {
		t.Fatalf("SetCustomStatus(over the cap only by spaces): %v", err)
	}
	u, _ := database.GetUserByID(ctx, 1)
	if u.CustomStatus == nil || len([]rune(*u.CustomStatus)) > MaxCustomStatusLen {
		t.Fatalf("stored status = %v, want within the cap", u.CustomStatus)
	}

	// 32 two-letter words joined by single spaces is 95 runes: over the
	// 32-rune display-name cap even after collapsing.
	over := strings.TrimSpace(strings.Repeat("ab  ", MaxDisplayNameLen))
	name := over
	if _, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", DisplayName: &name}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("display_name over the cap after collapsing = %v, want ErrBadRequest", err)
	}
}

func TestGroupDMName_CharacterRules(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUser(t, database, &db.User{ID: 3, Username: "carol"})
	svc := NewDMService(database, NewPermissionService(database, permissions.NewChecker(database)))
	ctx := context.Background()

	if _, err := svc.CreateGroupDM(ctx, 1, []int64{2, 3}, "line one\nline two"); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("CreateGroupDM with a newline in the name = %v, want ErrBadRequest", err)
	}
	res, err := svc.CreateGroupDM(ctx, 1, []int64{2, 3}, "book   club")
	if err != nil {
		t.Fatalf("CreateGroupDM: %v", err)
	}
	if res.Channel.Name != "book club" {
		t.Fatalf("group name = %q, want collapsed %q", res.Channel.Name, "book club")
	}
	if _, err := svc.RenameGroupDM(ctx, 1, res.Channel.ID, "bad\u202ename"); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("RenameGroupDM with a bidi override = %v, want ErrBadRequest", err)
	}
	if _, err := svc.RenameGroupDM(ctx, 1, res.Channel.ID, "bad\nname"); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("RenameGroupDM with a newline = %v, want ErrBadRequest", err)
	}
}
