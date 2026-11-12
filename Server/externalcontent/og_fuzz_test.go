package externalcontent

import (
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func fuzzCheckCapped(t *testing.T, field string, v *string) {
	t.Helper()
	if v != nil && utf8.RuneCountInString(*v) > maxFieldChars {
		t.Fatalf("%s holds %d characters, over the %d cap", field, utf8.RuneCountInString(*v), maxFieldChars)
	}
}

// FuzzParseOGTags reads arbitrary bytes as a fetched page. It must not panic,
// must give the same answer twice, and every text field that reaches a client
// stays inside the length cap.
func FuzzParseOGTags(f *testing.F) {
	seeds := []string{
		``,
		`<html><head><title> Hi </title><meta property="og:title" content="OG"></head></html>`,
		`<meta name="description" content="d"><meta property="og:description">`,
		`<meta property="og:image" content="https://x/a.png"><meta property="og:image:width" content="640"><meta property="og:image:height" content="-1">`,
		`<meta property="og:image:width" content="99999999999999999999">`,
		`<title>a<title>b</title>`,
		`<!-- <meta property="og:title" content="no"> --><script><meta property="og:title" content="no"></script>`,
		`<meta property="og:title" property="og:site_name" name="x" content="a" content="b">`,
		`<title>` + strings.Repeat("é", 2000) + `</title>`,
		"<meta property=og:title content=\xff\xfe>",
		strings.Repeat(`<meta property="og:x" content="y">`, 200),
	}
	for _, s := range seeds {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, page []byte) {
		got := parseOGTags(page)
		if again := parseOGTags(page); !reflect.DeepEqual(got, again) {
			t.Fatalf("two parses of the same page differ: %+v vs %+v", got, again)
		}
		fuzzCheckCapped(t, "Title", got.Title)
		fuzzCheckCapped(t, "Description", got.Description)
		fuzzCheckCapped(t, "SiteName", got.SiteName)
	})
}

// FuzzParseOEmbed reads arbitrary bytes as an oEmbed response. It must not
// panic; a refusal is the zero preview, and an accepted one carries at most a
// capped title and nothing else.
func FuzzParseOEmbed(f *testing.F) {
	seeds := []string{
		``,
		`{}`,
		`null`,
		`[]`,
		`{"type":"video","version":"1.0","title":"T"}`,
		`{"type":"rich","version":"1.0","title":7}`,
		`{"type":"rich","version":"1.0","title":"` + strings.Repeat("x", 3000) + `"}`,
		`{"type":"rich"}`,
		`{"type":null,"version":null,"title":null}`,
		`{"type":"a","version":"1","title":"\ud800"}`,
	}
	for _, s := range seeds {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, body []byte) {
		got, ok := parseOEmbed(body)
		if !ok {
			if !reflect.DeepEqual(got, previewData{}) {
				t.Fatalf("a refused oEmbed body still produced %+v", got)
			}
			return
		}
		fuzzCheckCapped(t, "Title", got.Title)
		if got.Description != nil || got.SiteName != nil || got.ImageURL != "" || got.ImageWidth != nil || got.ImageHeight != nil {
			t.Fatalf("an oEmbed body produced fields beyond the title: %+v", got)
		}
	})
}
