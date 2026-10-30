package externalcontent

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
)

// maxFieldChars is the longest string any preview field carries.
const maxFieldChars = 1024

// previewData is what a page reduces to before its image becomes a handle.
type previewData struct {
	Title       *string
	Description *string
	SiteName    *string
	ImageURL    string
	ImageWidth  *uint32
	ImageHeight *uint32
}

// size is the cache weight of a preview: its strings plus a fixed overhead.
func (p previewData) size() int64 {
	n := int64(128 + len(p.ImageURL))
	for _, s := range []*string{p.Title, p.Description, p.SiteName} {
		if s != nil {
			n += int64(len(*s))
		}
	}
	return n
}

func capText(s string) string {
	if utf8.RuneCountInString(s) <= maxFieldChars {
		return s
	}
	r := []rune(s)
	return string(r[:maxFieldChars])
}

// ogTags are the Open Graph fields a page names.
type ogTags struct {
	Title       *string
	Description *string
	Image       *string
	SiteName    *string
	ImageWidth  *uint32
	ImageHeight *uint32
}

// ogScan is the state of one pass over a page's tokens.
type ogScan struct {
	byProperty   map[string]*string
	byName       map[string]*string
	title        *string
	inFirstTitle bool
}

// meta records one <meta> element: the first property= and the first name=
// for each key win, with whatever content attribute they carry.
func (s *ogScan) meta(z *html.Tokenizer, hasAttr bool) {
	var property, name, content *string
	for hasAttr {
		var key, val []byte
		key, val, hasAttr = z.TagAttr()
		v := string(val)
		switch string(key) {
		case "property":
			property = firstOf(property, v)
		case "name":
			name = firstOf(name, v)
		case "content":
			content = firstOf(content, v)
		}
	}
	if property != nil {
		if _, seen := s.byProperty[*property]; !seen {
			s.byProperty[*property] = content
		}
	}
	if name != nil {
		if _, seen := s.byName[*name]; !seen {
			s.byName[*name] = content
		}
	}
}

func firstOf(cur *string, v string) *string {
	if cur != nil {
		return cur
	}
	return &v
}

// token feeds one token to the scan.
func (s *ogScan) token(z *html.Tokenizer, tt html.TokenType) {
	switch tt { //nolint:exhaustive // only tags and text carry metadata
	case html.StartTagToken, html.SelfClosingTagToken:
		name, hasAttr := z.TagName()
		switch string(name) {
		case "meta":
			s.meta(z, hasAttr)
		case "title":
			if s.title == nil && tt == html.StartTagToken {
				empty := ""
				s.title = &empty
				s.inFirstTitle = true
			}
		}
	case html.EndTagToken:
		if name, _ := z.TagName(); string(name) == "title" {
			s.inFirstTitle = false
		}
	case html.TextToken:
		if s.inFirstTitle {
			*s.title += string(z.Text())
		}
	}
}

// lookup is the first of names a page names, meta[property] before
// meta[name]; a match with no content attribute yields nothing.
func (s *ogScan) lookup(names ...string) *string {
	for _, n := range names {
		if v, ok := s.byProperty[n]; ok && v != nil {
			return v
		}
		if v, ok := s.byName[n]; ok && v != nil {
			return v
		}
	}
	return nil
}

func (s *ogScan) dimension(name string) *uint32 {
	v := s.lookup(name)
	if v == nil {
		return nil
	}
	parsed, err := strconv.ParseUint(strings.TrimSpace(*v), 10, 32)
	if err != nil {
		return nil
	}
	d := uint32(parsed)
	return &d
}

func capped(v *string) *string {
	if v == nil {
		return nil
	}
	c := capText(*v)
	return &c
}

// parseOGTags reads Open Graph metadata the way the desktop broker does:
//   - for each name in order, the first meta[property=name] in document order
//     wins, else the first meta[name=name]; a match with no content attribute
//     yields nothing and the next name is tried, an empty content is "";
//   - title = og:title, else the first <title>'s text, trimmed;
//   - description = og:description, else description.
//
// The tokenizer is the HTML spec's, so meta-like text inside comments,
// scripts and styles is not a tag, and it runs in linear time.
func parseOGTags(page []byte) ogTags {
	s := &ogScan{byProperty: map[string]*string{}, byName: map[string]*string{}}
	z := html.NewTokenizer(bytes.NewReader(page))
	for tt := z.Next(); tt != html.ErrorToken; tt = z.Next() {
		s.token(z, tt)
	}
	out := ogTags{
		Description: capped(s.lookup("og:description", "description")),
		Image:       s.lookup("og:image"),
		SiteName:    capped(s.lookup("og:site_name")),
		ImageWidth:  s.dimension("og:image:width"),
		ImageHeight: s.dimension("og:image:height"),
	}
	if t := s.lookup("og:title"); t != nil {
		out.Title = capped(t)
	} else if s.title != nil {
		trimmed := strings.TrimSpace(*s.title)
		out.Title = capped(&trimmed)
	}
	return out
}

// parseOEmbed reads the title of an oEmbed document: a JSON object with
// "type" and "version". Any other JSON is not a preview.
func parseOEmbed(body []byte) (previewData, bool) {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(body, &doc); err != nil {
		return previewData{}, false
	}
	_, hasType := doc["type"]
	_, hasVersion := doc["version"]
	if !hasType || !hasVersion {
		return previewData{}, false
	}
	var out previewData
	var title string
	if raw, ok := doc["title"]; ok && json.Unmarshal(raw, &title) == nil {
		c := capText(title)
		out.Title = &c
	}
	return out, true
}
