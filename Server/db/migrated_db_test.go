package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// seedBlockUser inserts a minimal user row with an explicit id so block tests
// satisfy the user_blocks foreign keys.
func seedBlockUser(t *testing.T, database *db.DB, id int64, username string) {
	t.Helper()
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO users (id, username, password) VALUES (?, ?, 'x')`, id, username)
	if err != nil {
		t.Fatalf("seed user %d: %v", id, err)
	}
}
