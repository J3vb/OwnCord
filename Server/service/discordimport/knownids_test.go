package discordimport

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestKnownIDs_NumericAndFallbackKeysLink(t *testing.T) {
	k := newKnownIDs()
	k.put("1100000000000000001", 5)
	k.put("not-a-number", 6)
	k.put("007", 7) // not canonical: must not alias "7"

	for key, want := range map[string]int64{"1100000000000000001": 5, "not-a-number": 6, "007": 7} {
		if got, ok := k.get(key); !ok || got != want {
			t.Errorf("get(%q) = %d, %v; want %d", key, got, ok, want)
		}
	}
	if _, ok := k.get("7"); ok {
		t.Error(`"7" resolved through "007"`)
	}
	if len(k.num) != 1 {
		t.Errorf("numeric entries = %d, want 1", len(k.num))
	}
}

func TestKnownIDs_ForRepliesHandsOverOnlyWhatTheChunkPointsAt(t *testing.T) {
	k := newKnownIDs()
	k.put("1", 10)
	k.put("2", 20)
	got := k.forReplies([]db.ImportMessage{{ReplyKey: "2"}, {ReplyKey: "9"}, {}})
	if len(got) != 1 || got["2"] != 20 {
		t.Errorf("forReplies = %v, want only 2", got)
	}
}
