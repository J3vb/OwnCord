package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// importedRow is the slice of a message payload that identifies its author.
type importedRow struct {
	ID             int64 `json:"id"`
	MessageID      int64 `json:"message_id"`
	ImportedAuthor *struct {
		Name  string  `json:"name"`
		Color *string `json:"color"`
	} `json:"imported_author"`
}

func TestImportedAuthor_RESTPayloads(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "reader", 1)
	user, _ := database.GetUserByUsername(context.Background(), "reader")
	ctx := context.Background()
	chID, _ := database.CreateChannel(ctx, "imported", "text", "", "", 0)

	imp, _ := database.CreateMessage(ctx, chID, user.ID, "zebra imported", nil)
	native, _ := database.CreateMessage(ctx, chID, user.ID, "zebra native", nil)
	if _, err := database.ExecContext(ctx,
		`INSERT INTO message_import_authors (message_id, discord_user_id, name, color) VALUES (?, '42', 'Ann', '#ff8800')`, imp); err != nil {
		t.Fatal(err)
	}

	check := func(label string, rows []importedRow, idOf func(importedRow) int64) {
		t.Helper()
		seen := 0
		for _, r := range rows {
			switch idOf(r) {
			case imp:
				seen++
				if r.ImportedAuthor == nil || r.ImportedAuthor.Name != "Ann" || r.ImportedAuthor.Color == nil || *r.ImportedAuthor.Color != "#ff8800" {
					t.Errorf("%s: imported row = %+v", label, r.ImportedAuthor)
				}
			case native:
				seen++
				if r.ImportedAuthor != nil {
					t.Errorf("%s: native row carries imported_author", label)
				}
			}
		}
		if seen == 0 {
			t.Errorf("%s: no rows matched", label)
		}
	}
	msgID := func(r importedRow) int64 { return r.ID }

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", chID), token)
	var hist struct {
		Messages []importedRow `json:"messages"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &hist); err != nil {
		t.Fatal(err)
	}
	check("history", hist.Messages, msgID)
	if strings.Contains(rr.Body.String(), "discord_user_id") || strings.Contains(rr.Body.String(), "\"42\"") {
		t.Error("history leaks the Discord user id")
	}

	rr = chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages/around/%d", chID, imp), token)
	var around struct {
		Messages []importedRow `json:"messages"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &around); err != nil {
		t.Fatal(err)
	}
	check("around", around.Messages, msgID)

	rr = chGet(t, router, "/api/v1/search?q=zebra", token)
	var search struct {
		Results []importedRow `json:"results"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &search); err != nil {
		t.Fatal(err)
	}
	check("search", search.Results, func(r importedRow) int64 { return r.MessageID })
}
