package db_test

import (
	"errors"
	"fmt"
	"testing"

	"github.com/owncord/server/db"
)

// ─── Sentinel error identity ─────────────────────────────────────────────────

func TestSentinelErrors_AreDistinct(t *testing.T) {
	sentinels := []struct {
		name string
		err  error
	}{
		{"ErrNotFound", db.ErrNotFound},
		{"ErrForbidden", db.ErrForbidden},
		{"ErrConflict", db.ErrConflict},
		{"ErrBanned", db.ErrBanned},
		{"ErrLastAdmin", db.ErrLastAdmin},
	}

	for i, a := range sentinels {
		for j, b := range sentinels {
			if i == j {
				continue
			}
			if errors.Is(a.err, b.err) {
				t.Errorf("%s should not match %s", a.name, b.name)
			}
		}
	}
}

func TestSentinelErrors_MatchThemselves(t *testing.T) {
	sentinels := []struct {
		name string
		err  error
	}{
		{"ErrNotFound", db.ErrNotFound},
		{"ErrForbidden", db.ErrForbidden},
		{"ErrConflict", db.ErrConflict},
		{"ErrBanned", db.ErrBanned},
		{"ErrLastAdmin", db.ErrLastAdmin},
	}

	for _, tc := range sentinels {
		t.Run(tc.name, func(t *testing.T) {
			if !errors.Is(tc.err, tc.err) {
				t.Errorf("errors.Is(%s, %s) = false, want true", tc.name, tc.name)
			}
		})
	}
}

func TestSentinelErrors_MatchWrapped(t *testing.T) {
	sentinels := []struct {
		name string
		err  error
	}{
		{"ErrNotFound", db.ErrNotFound},
		{"ErrForbidden", db.ErrForbidden},
		{"ErrConflict", db.ErrConflict},
		{"ErrBanned", db.ErrBanned},
		{"ErrLastAdmin", db.ErrLastAdmin},
	}

	for _, tc := range sentinels {
		t.Run(tc.name, func(t *testing.T) {
			wrapped := fmt.Errorf("operation failed: %w", tc.err)
			if !errors.Is(wrapped, tc.err) {
				t.Errorf("errors.Is(wrapped, %s) = false, want true", tc.name)
			}
		})
	}
}

func TestSentinelErrors_DoubleWrapped(t *testing.T) {
	inner := fmt.Errorf("db query: %w", db.ErrNotFound)
	outer := fmt.Errorf("handler: %w", inner)

	if !errors.Is(outer, db.ErrNotFound) {
		t.Error("double-wrapped ErrNotFound should still match")
	}
}

func TestSentinelErrors_HaveNonEmptyMessages(t *testing.T) {
	sentinels := []error{
		db.ErrNotFound,
		db.ErrForbidden,
		db.ErrConflict,
		db.ErrBanned,
		db.ErrLastAdmin,
	}

	for _, err := range sentinels {
		if err.Error() == "" {
			t.Errorf("sentinel error has empty message")
		}
	}
}

// ─── IsUniqueConstraintError ─────────────────────────────────────────────────

func TestIsUniqueConstraintError_MatchesSQLiteMessage(t *testing.T) {
	sqliteErr := errors.New("UNIQUE constraint failed: users.username")
	if !db.IsUniqueConstraintError(sqliteErr) {
		t.Error("should match SQLite UNIQUE constraint error")
	}
}

func TestIsUniqueConstraintError_CaseSensitive(t *testing.T) {
	lower := errors.New("unique constraint failed: users.username")
	if db.IsUniqueConstraintError(lower) {
		t.Error("should be case-sensitive (SQLite always uses uppercase UNIQUE)")
	}
}

func TestIsUniqueConstraintError_NilError(t *testing.T) {
	if db.IsUniqueConstraintError(nil) {
		t.Error("nil error should return false")
	}
}

func TestIsUniqueConstraintError_UnrelatedError(t *testing.T) {
	unrelated := errors.New("connection refused")
	if db.IsUniqueConstraintError(unrelated) {
		t.Error("unrelated error should return false")
	}
}

func TestIsUniqueConstraintError_WrappedSQLiteError(t *testing.T) {
	inner := errors.New("UNIQUE constraint failed: users.email")
	wrapped := fmt.Errorf("insert user: %w", inner)
	// The function uses strings.Contains on err.Error(), so wrapping preserves the substring.
	if !db.IsUniqueConstraintError(wrapped) {
		t.Error("wrapped UNIQUE constraint error should match (message preserved in chain)")
	}
}
