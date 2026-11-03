package service

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// ChannelService's parts must all reach the same store: the override part
// asserts the category slices on it at construction, and a part handed a
// narrower wrapper would quietly lose them.
func TestChannelServicePartsShareStore(t *testing.T) {
	database := newTestDB(t)
	svc := New(database, auth.NewRateLimiter()).Channels
	for name, st := range map[string]any{
		"core":      svc.st,
		"overrides": svc.channelOverrides.st,
		"focus":     svc.readFocus.st,
	} {
		if st != any(database) {
			t.Errorf("%s store = %T, want the shared *db.DB", name, st)
		}
	}
	if svc.cperm == nil || svc.channelOverrides.cats == nil {
		t.Error("override part lost the category store capabilities")
	}
}

// The permission notifier is installed on ChannelService after construction; it
// must land on the override part, the only code that fans out audience changes.
func TestServicesNotifierReachesOverridePart(t *testing.T) {
	database := newTestDB(t)
	svcs := New(database, auth.NewRateLimiter())
	if svcs.Channels.channelOverrides == nil || svcs.Channels.readFocus == nil {
		t.Fatal("service.New did not wire the channel parts")
	}
	n := &permNotifyRecorder{}
	svcs.Channels.SetPermissionNotifier(n)
	if got := svcs.Channels.notifier; got != PermissionChangeNotifier(n) {
		t.Errorf("override part notifier = %v, want the installed %v", got, n)
	}
}
