package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Tests for the pass cap on the text sanitizer and for the order of an edit's checks. The tests that count
// passes swap a package variable, so they do not run in parallel.

// countSanitizePasses wraps sanitizePassFn with a counter for the rest of the test.
func countSanitizePasses(t *testing.T) *int {
	t.Helper()
	n := new(int)
	orig := sanitizePassFn
	sanitizePassFn = func(s string) string {
		*n++
		return orig(s)
	}
	t.Cleanup(func() { sanitizePassFn = orig })
	return n
}

// unsettledTexts are message-sized texts that keep changing under the sanitizer far past the pass cap.
func unsettledTexts() map[string]string {
	return map[string]string{
		"layered entities": "&" + strings.Repeat("amp;", 3998) + "lt;",
		"layered brackets": strings.Repeat("<", 4000) + "a" + strings.Repeat(">a", 3999),
	}
}

func TestSanitize_StopsAtPassCap(t *testing.T) {
	for name, raw := range unsettledTexts() {
		t.Run(name, func(t *testing.T) {
			passes := countSanitizePasses(t)
			out, err := sanitizeToFixpoint(raw)
			if !errors.Is(err, ErrBadRequest) || out != "" {
				t.Fatalf("sanitizeToFixpoint = %q, %v; want no text and ErrBadRequest", out, err)
			}
			if *passes != maxSanitizePasses {
				t.Fatalf("ran %d passes, want exactly the cap %d", *passes, maxSanitizePasses)
			}
		})
	}
}

func TestSanitizeContent_RefusesTextThatDoesNotSettle(t *testing.T) {
	for name, raw := range unsettledTexts() {
		t.Run(name, func(t *testing.T) {
			if len(raw) > maxMessageLen*4 {
				t.Fatalf("fixture is %d bytes, over the raw limit; it would not reach the sanitizer", len(raw))
			}
			if _, err := sanitizeContent(raw, true); !errors.Is(err, ErrBadRequest) {
				t.Fatalf("sanitizeContent: err = %v, want ErrBadRequest", err)
			}
			if out, err := SanitizeText(raw); err == nil || out != "" {
				t.Fatalf("SanitizeText = %q, %v; want no text and an error", out, err)
			}
			if got := SanitizeImportedContent(raw); got != "" {
				t.Fatalf("SanitizeImportedContent = %q, want it stored empty", got)
			}
		})
	}
}

// TestSanitize_FieldCleanersRefuseTextThatDoesNotSettle covers the field-sized callers: a short text with
// enough entity layers to pass the cap is refused, not stored part-cleaned.
func TestSanitize_FieldCleanersRefuseTextThatDoesNotSettle(t *testing.T) {
	t.Parallel()
	raw := "&" + strings.Repeat("amp;", 20) + "lt;b&gt;x"
	cleaners := map[string]func() error{
		"cleanTextBounded": func() error {
			_, err := cleanTextBounded(raw, MaxThreadNameLen, "name")
			return err
		},
		"cleanVisibleBounded": func() error {
			_, err := cleanVisibleBounded(raw, MaxDisplayNameLen, "display_name")
			return err
		},
		"pollText": func() error {
			_, err := pollText(raw, "question", maxPollQuestionRunes)
			return err
		},
		"cleanAboutPatch": func() error {
			_, err := cleanAboutPatch(&raw)
			return err
		},
	}
	for name, clean := range cleaners {
		if err := clean(); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want ErrBadRequest", name, err)
		}
	}
}

func TestSanitize_SettledTextUnchanged(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("é", maxMessageLen)
	cases := []struct{ in, want string }{
		{"don't", "don't"},
		{">", ">"},
		{`"`, `"`},
		{"&", "&"},
		{"a & b > c", "a & b > c"},
		{"&amp;lt;script&amp;gt;", ""},
		{"<<script>script>alert(1)<</script>/script>", ""},
		{"&lt;b&gt;hi&lt;/b&gt;", "hi"},
		{"&amp;amp;amp;amp;lt;b&amp;amp;amp;amp;gt;x", "x"},
		{long, long},
	}
	for _, c := range cases {
		got, err := sanitizeContent(c.in, true)
		if err != nil {
			t.Errorf("sanitizeContent(%.40q): %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("sanitizeContent(%.40q) = %.40q, want %.40q", c.in, got, c.want)
		}
		if again := sanitizePass(got); again != got {
			t.Errorf("output of %.40q changed under another pass: %.40q", c.in, again)
		}
	}
}

// newEditAccessFixture is the alice/bob DM (channel 50) plus carol (3), a member outside it, and one message
// alice sent there.
func newEditAccessFixture(t *testing.T) (*MessageService, int64) {
	t.Helper()
	database, permSvc := newDMFixture(t)
	seedUser(t, database, &db.User{ID: 3, Username: "carol"})
	seedUserRole(t, database, 3, permissions.MemberRoleID)
	svc := NewMessageService(database, permSvc, nil)
	sent := mustSendMessage(context.Background(), t, svc, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi bob",
	})
	return svc, sent.MessageID
}

func TestEditMessage_SanitizesOnlyAfterAccessCheck(t *testing.T) {
	svc, msgID := newEditAccessFixture(t)
	ctx := context.Background()
	passes := countSanitizePasses(t)

	for _, editor := range []int64{3, 2} { // outside the DM; inside it but not the author
		if _, err := svc.EditMessage(ctx, editor, msgID, unsettledTexts()["layered entities"]); !errors.Is(err, ErrForbidden) {
			t.Fatalf("edit by user %d: err = %v, want ErrForbidden", editor, err)
		}
	}
	if *passes != 0 {
		t.Fatalf("refused edits ran the sanitizer %d times, want 0", *passes)
	}

	if _, err := svc.EditMessage(ctx, 1, msgID, "edited"); err != nil {
		t.Fatalf("author's edit: %v", err)
	}
	if *passes == 0 {
		t.Fatal("the author's edit was applied without running the sanitizer")
	}
}

func TestEditAndDelete_DeletedRowAnswerDependsOnAccess(t *testing.T) {
	t.Parallel()
	svc, msgID := newEditAccessFixture(t)
	ctx := context.Background()
	if _, err := svc.DeleteMessage(ctx, 1, msgID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	ops := map[string]func(userID int64) error{
		"edit": func(userID int64) error {
			_, err := svc.EditMessage(ctx, userID, msgID, "again")
			return err
		},
		"delete": func(userID int64) error {
			_, err := svc.DeleteMessage(ctx, userID, msgID)
			return err
		},
	}
	callers := []struct {
		name   string
		userID int64
		want   error
	}{
		{"author", 1, ErrDeletedMessage},
		{"reader of the channel", 2, ErrDeletedMessage},
		{"outside the channel", 3, ErrForbidden},
	}
	for op, run := range ops {
		for _, c := range callers {
			err := run(c.userID)
			if !errors.Is(err, c.want) {
				t.Errorf("%s by %s: err = %v, want %v", op, c.name, err, c.want)
			}
			if errors.Is(c.want, ErrForbidden) && errors.Is(err, ErrDeletedMessage) {
				t.Errorf("%s by %s: answer names the row's state: %v", op, c.name, err)
			}
		}
	}
}
