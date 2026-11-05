package service

import (
	"context"
	"testing"
)

// warnMember issues a moderator warning against the fixture member and
// returns its action id, the starting point of nearly every appeal test.
func (f *appealFixture) warnMember(ctx context.Context, t *testing.T, reason string) int64 {
	t.Helper()
	actionID, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, reason, nil)
	mustDo(t, "Warn", err)
	return actionID
}

// submitAppeal files an appeal as the fixture member against actionID and
// returns its public id.
func (f *appealFixture) submitAppeal(ctx context.Context, t *testing.T, actionID int64, reason string) string {
	t.Helper()
	publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, reason)
	mustDo(t, "Submit", err)
	return publicID
}

// openAppeal warns the fixture member and files an appeal for that warning.
func (f *appealFixture) openAppeal(ctx context.Context, t *testing.T) string {
	t.Helper()
	return f.submitAppeal(ctx, t, f.warnMember(ctx, t, "x"), "please")
}
