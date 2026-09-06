package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// forbiddenModerationIdentifiers are the symbols workstream 10's absence
// proof says no plugin host file may name: the moderation and report
// services, and the mechanisms behind all five action kinds.
var forbiddenModerationIdentifiers = []string{
	"ModerationService", "ReportService", "BanUser", "ForceLogout", "Warn(", "Timeout(",
}

// TestAbsenceContract_NoPluginModerationCapability is workstream 10's
// absence proof (B5-9): no file under Server/plugin/host_*.go names a
// function that reaches ModerationService, ReportService, or any of the
// five action mechanisms. A source-text scan rather than a call-graph walk,
// deliberately conservative — a plugin host file may not even MENTION these
// identifiers, so a future refactor that routes a capability through an
// intermediate helper still has to touch this test to add the capability at
// all, and reviewing that touch is exactly the point.
func TestAbsenceContract_NoPluginModerationCapability(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "plugin", "host_*.go"))
	if err != nil {
		t.Fatalf("glob host_*.go: %v", err)
	}
	var scanned int
	var hits []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		scanned++
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		content := string(raw)
		for _, sym := range forbiddenModerationIdentifiers {
			if strings.Contains(content, sym) {
				hits = append(hits, filepath.Base(f)+": "+sym)
			}
		}
	}
	// Vacuity guard: the walk must have actually scanned the plugin host
	// surface, not an empty or renamed directory.
	if scanned < 4 {
		t.Fatalf("scanned only %d non-test host_*.go files; expected the full plugin host surface (>= 4)", scanned)
	}
	if len(hits) > 0 {
		t.Fatalf("Server/plugin host files name a moderation capability, which must not exist:\n  %s", strings.Join(hits, "\n  "))
	}
}

// TestModerationService_RefusesNonHumanActor is the absence proof's other
// half: every ModerationService action method rejects actorID <= 0 with
// ErrForbidden before any other check — a plugin capability (or any other
// non-human caller) can never reach the ledger, and there is deliberately no
// schema CHECK enforcing this (erasure sets actor_id to 0 for an erased
// moderator, and a constraint would forbid that transition).
func TestModerationService_RefusesNonHumanActor(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	cases := []struct {
		kind string
		run  func(actorID int64) error
	}{
		{"warning", func(actorID int64) error {
			_, err := f.mod.Warn(ctx, actorID, fixtureMember, "x", nil)
			return err
		}},
		{"timeout", func(actorID int64) error {
			_, err := f.mod.Timeout(ctx, actorID, fixtureMember, "x", time.Hour, nil)
			return err
		}},
		{"kick", func(actorID int64) error { return f.mod.ForceLogout(ctx, actorID, fixtureMember) }},
		{"ban", func(actorID int64) error { return f.mod.BanUser(ctx, actorID, fixtureMember, "x", nil) }},
		{"removal", func(actorID int64) error {
			msgID, err := f.database.CreateMessage(ctx, fixtureChannel, fixtureMember2, "hi", nil)
			if err != nil {
				t.Fatalf("CreateMessage: %v", err)
			}
			return f.mod.ActOnReport(ctx, ActOnReportParams{ActorID: actorID, Kind: "removal", MessageID: msgID, ReportID: 1})
		}},
	}
	for _, actorID := range []int64{0, -1} {
		for _, tc := range cases {
			t.Run(fmt.Sprintf("%s/actor=%d", tc.kind, actorID), func(t *testing.T) {
				if err := tc.run(actorID); !errors.Is(err, ErrForbidden) {
					t.Fatalf("actorID=%d: want ErrForbidden, got %v", actorID, err)
				}
			})
		}
	}
}
