package service

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// UserService's parts must all reach the same store: the nickname path asserts
// an optional capability on the core's store at run time, and a part handed a
// narrower wrapper would quietly lose it.
func TestUserServicePartsShareStore(t *testing.T) {
	database := newTestDB(t)
	users := NewUserService(database)
	for name, st := range map[string]any{
		"core":          users.st,
		"sessions":      users.userSessions.st,
		"registrations": users.registrationQueue.st,
	} {
		if st != any(database) {
			t.Errorf("%s store = %T, want the shared *db.DB", name, st)
		}
	}
	if _, ok := users.st.(NicknameStore); !ok {
		t.Error("core store lost the optional NicknameStore capability")
	}
}

// The welcome hook is installed on UserService after construction; it must land
// on the registration part, which is the only code that greets.
func TestServicesWelcomeReachesRegistrationPart(t *testing.T) {
	database := newTestDB(t)
	svcs := New(database, auth.NewRateLimiter())
	if svcs.Welcome == nil {
		t.Fatal("Services.Welcome is nil; the fixture store should support welcome rows")
	}
	if got := svcs.Users.registrationQueue.welcome; got != svcs.Welcome {
		t.Errorf("registration part welcome = %p, want the shared %p", got, svcs.Welcome)
	}
}
