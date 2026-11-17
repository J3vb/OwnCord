package linkpreview

import (
	"reflect"
	"strings"
	"testing"
)

// The cases of extractUrls in Client/tests/unit/media/urlsAndEmbeds.test.ts,
// chat-parity-3a2.test.ts and content-markdown.test.ts, one for one. Change a row here only
// with the client's.
func TestExtractURLs_ParityWithClient(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"single", "Check out https://example.com", []string{"https://example.com"}},
		{"multiple", "Visit https://a.com and https://b.com", []string{"https://a.com", "https://b.com"}},
		{"none", "Just plain text here", nil},
		{"code block", "```\nhttps://hidden.com\n```", nil},
		{"inline code", "See `https://hidden.com` here", nil},
		{"spoiler whole", "||https://example.com/a.png||", nil},
		{"spoiler and outside", "look ||https://example.com/a.png|| and https://example.com/b", []string{"https://example.com/b"}},
		{"spoiler with prose", "||see https://example.com/a.png now||", nil},
		{"spoiler across lines", "||first\nhttps://example.com/a.png||", nil},
		{"spoiler without url", "||secret|| https://example.com/x", []string{"https://example.com/x"}},
		{"single pipe", "a | https://example.com/x", []string{"https://example.com/x"}},
		{"two single pipes", "a | b | https://example.com/x", []string{"https://example.com/x"}},
		{"empty spoiler pair", "|||| https://example.com/x", []string{"https://example.com/x"}},
		{"escaped pipe in spoiler 1", "||secret \\|| https://example.com/a.png ||", nil},
		{"escaped pipe in spoiler 2", "||a\\|b https://example.com/x||", nil},
		{"spoiler over blank line", "||secret\n\nhttps://example.com/a.png||", nil},
		{"spoiler over spaced blank line", "||secret\n  \nhttps://example.com/a.png||", nil},
		{"escaped pipe after opener", "||\\|a https://example.com/x||", nil},
		{"escaped backslash ends spoiler", "||a\\\\|| https://example.com/x", []string{"https://example.com/x"}},
		{"escaped pipe outside spoiler", "a \\| https://example.com/x", []string{"https://example.com/x"}},
		{"escaped pipe then lone pipe", "||oops \\|| https://example.com/x", []string{"https://example.com/x"}},
		{"unclosed spoiler", "||oops https://example.com/x", []string{"https://example.com/x"}},
		{"code block next to url", "https://visible.com ```https://hidden.com```", []string{"https://visible.com"}},
		{"http and https", "http://insecure.com https://secure.com", []string{"http://insecure.com", "https://secure.com"}},
		{"trailing period", "Nice pic https://cdn.example.com/a.png.", []string{"https://cdn.example.com/a.png"}},
		{"wrapping paren", "(https://cdn.example.com/a.png)", []string{"https://cdn.example.com/a.png"}},
		{"balanced paren", "See https://en.wikipedia.org/wiki/Rust_(programming_language) for details", []string{"https://en.wikipedia.org/wiki/Rust_(programming_language)"}},
		{"youtube punctuation", "Check https://youtu.be/dQw4w9WgXcQ.", []string{"https://youtu.be/dQw4w9WgXcQ"}},
		{"angle link", "<https://a.example/x>", nil},
		{"angle and plain", "<https://a.example/x> https://b.example/y", []string{"https://b.example/y"}},
		{"escaped angle", "\\<https://a.example/x>", []string{"https://a.example/x"}},
		{"double-escaped angle", "\\\\<https://a.example/x>", nil},
		{"masked link", "[docs](https://example.com/a.png)", nil},
		{"plain link", "plain https://example.com/a.png", []string{"https://example.com/a.png"}},
		{"masked with balanced parens", "[w](https://en.wikipedia.org/wiki/Rust_(x)) https://b.example/", []string{"https://b.example/"}},
		{"upper case angle", "<HTTPS://a.example/x>", nil},
		{"quote ends link", `see "https://a.example/x" ok`, []string{"https://a.example/x"}},
		{"bare scheme is no link", "https:// nothing", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ExtractURLs(tc.in)
			if len(got) == 0 && len(tc.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("ExtractURLs(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestLinks_DedupesNormalisesAndCaps(t *testing.T) {
	in := "https://A.example/x https://a.example:443/x#frag https://b.example http://user:pw@c.example " +
		"https://d.example https://e.example https://f.example https://g.example"
	got := Links(in)
	if len(got) != MaxLinksPerMessage {
		t.Fatalf("links = %d, want the cap %d: %+v", len(got), MaxLinksPerMessage, got)
	}
	want := []string{"https://a.example/x", "https://b.example/", "https://d.example/", "https://e.example/", "https://f.example/"}
	for i, l := range got {
		if l.URL != want[i] {
			t.Errorf("link %d = %q, want %q", i, l.URL, want[i])
		}
		if h, _, _ := URLHash(l.URL); h != l.Hash {
			t.Errorf("link %d hash mismatch", i)
		}
	}
	if Links("nothing here") != nil {
		t.Error("links of plain text should be nil")
	}
}

func TestExtractURLs_LongInputStaysQuick(t *testing.T) {
	in := strings.Repeat("[", 4000) + strings.Repeat("|", 4000)
	if got := ExtractURLs(in); len(got) != 0 {
		t.Errorf("got %v", got)
	}
}
