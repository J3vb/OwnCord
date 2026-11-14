package linkwire

import (
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

func TestFromRow(t *testing.T) {
	cases := []struct {
		name string
		row  dbgen.ListMessageLinkPreviewsRow
		ok   bool
	}{
		{"text only", dbgen.ListMessageLinkPreviewsRow{Url: "u", Title: new("t")}, true},
		{"image only", dbgen.ListMessageLinkPreviewsRow{Url: "u", ImageHash: new("h"), ImageWidth: new(int64(5)), ImageHeight: new(int64(4))}, true},
		{"failed fetch", dbgen.ListMessageLinkPreviewsRow{Url: "u", Title: new("t"), Failure: new("oversized")}, false},
		{"nothing to show", dbgen.ListMessageLinkPreviewsRow{Url: "u"}, false},
		{"empty strings are nothing", dbgen.ListMessageLinkPreviewsRow{Url: "u", Title: new(""), SiteName: new("")}, false},
		{"image row swept away", dbgen.ListMessageLinkPreviewsRow{Url: "u", ImageHash: new("h")}, false},
	}
	for _, tc := range cases {
		if _, ok := FromRow(tc.row); ok != tc.ok {
			t.Errorf("%s: ok = %v, want %v", tc.name, ok, tc.ok)
		}
	}
}

func TestCards_KeepOrderAndJSONShape(t *testing.T) {
	rows := []dbgen.ListMessageLinkPreviewsRow{
		{Url: "https://a/", Title: new("A"), Description: new("d"), SiteName: new("S"), ImageHash: new("h"), ImageWidth: new(int64(640)), ImageHeight: new(int64(320))},
		{Url: "https://b/", Failure: new("unavailable")},
		{Url: "https://c/", Title: new("C")},
	}
	cards := Cards(rows)
	if len(cards) != 2 || cards[0].URL != "https://a/" || cards[1].URL != "https://c/" {
		t.Fatalf("cards = %+v", cards)
	}
	a, _ := json.Marshal(cards[0])
	if string(a) != `{"url":"https://a/","title":"A","description":"d","site_name":"S","image":{"hash":"h","width":640,"height":320}}` {
		t.Errorf("json = %s", a)
	}
	c, _ := json.Marshal(cards[1])
	if string(c) != `{"url":"https://c/","title":"C"}` {
		t.Errorf("json = %s", c)
	}
	if got := Cards(nil); got == nil || len(got) != 0 {
		t.Errorf("Cards(nil) = %#v, want an empty non-nil slice", got)
	}
}
