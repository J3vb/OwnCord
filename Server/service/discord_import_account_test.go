package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// The hidden import account must be unreachable as a person. Its stored
// password matches nothing, and the login path refuses it on the account kind
// as well, so a row given a real hash by mistake still cannot sign in.
func TestLogin_RefusesTheHiddenImportAccount(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	id, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)
	in := LoginInput{Username: "[imported]", Password: "!", Device: "d", IP: "203.0.113.9"}
	for _, pw := range []string{"!", "", "password123", "[imported]"} {
		in.Password = pw
		if _, err := svc.Login(ctx, in); !errors.Is(err, ErrInvalidCredentials) {
			t.Errorf("password %q: err = %v, want ErrInvalidCredentials", pw, err)
		}
	}

	hash, err := auth.HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE users SET password = ? WHERE id = ?`, hash, id); err != nil {
		t.Fatal(err)
	}
	in.Password = "correct horse battery"
	res, err := svc.Login(ctx, in)
	if !errors.Is(err, ErrInvalidCredentials) || res != nil {
		t.Errorf("a system row with a real hash signed in: %+v, %v", res, err)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM sessions`); n != 0 {
		t.Errorf("sessions issued = %d", n)
	}
}

func TestCreateDM_RefusesTheHiddenImportAccount(t *testing.T) {
	database, permSvc := newDMFixture(t)
	ctx := context.Background()
	id, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewDMService(database, permSvc).CreateDM(ctx, 1, id); err == nil {
		t.Fatal("a direct message to the import account was created")
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM dm_participants WHERE user_id = ?`, id); n != 0 {
		t.Errorf("import account is a DM participant (%d rows)", n)
	}
	u, err := database.GetUserByID(ctx, id)
	if err != nil || u == nil {
		t.Fatal(err)
	}
	if dmReachableUser(u) {
		t.Error("dmReachableUser accepted the import account")
	}
}
