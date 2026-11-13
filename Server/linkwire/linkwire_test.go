package linkwire

import (
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

func s(v string) *string { return &v }
func n(v int64) *int64   { return &v }

func TestFromRow(t *testing.T) {
	cases := []struct {
		name string
		row  dbgen.ListMessageLinkPreviewsRow
		ok   bool
	}{
		{"text only", dbgen.ListMessageLinkPreviewsRow{Url: "u", Title: s("t")}, true},
		{"image only", dbgen.ListMessageLinkPreviewsRow{Url: "u", ImageHash: s("h"), ImageWidth: n(5), ImageHeight: n(4)}, true},
		{"failed fetch", dbgen.ListMessageLinkPreviewsRow{Url: "u", Title: s("t"), Failure: s("oversized")}, false},
		{"nothing to show", dbgen.ListMessageLinkPreviewsRow{Url: "u"}, false},
		{"empty strings are nothing", dbgen.ListMessageLinkPreviewsRow{Url: "u", Title: s(""), SiteName: s("")}, false},
		{"image row swept away", dbgen.ListMessageLinkPreviewsRow{Url: "u", ImageHash: s("h")}, false},
	}
	for _, tc := range cases {
		if _, ok := FromRow(tc.row); ok != tc.ok {
			t.Errorf("%s: ok = %v, want %v", tc.name, ok, tc.ok)
		}
	}
}

func TestCards_KeepOrderAndJSONShape(t *testing.T) {
	rows := []dbgen.ListMessageLinkPreviewsRow{
		{Url: "https://a/", Title: s("A"), Description: s("d"), SiteName: s("S"), ImageHash: s("h"), ImageWidth: n(640), ImageHeight: n(320)},
		{Url: "https://b/", Failure: s("unavailable")},
		{Url: "https://c/", Title: s("C")},
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
