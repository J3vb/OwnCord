package main

import (
	"strings"
	"testing"
)

const sampleIndex = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-AbC123_x.js"></script>
<link rel="stylesheet" href="/assets/index-AbC123.css"></head><body></body></html>`

func TestFirstAssetScript(t *testing.T) {
	got, ok := firstAssetScript(sampleIndex)
	if !ok || got != "/assets/index-AbC123_x.js" {
		t.Fatalf("got %q, %v", got, ok)
	}
	if _, ok := firstAssetScript(`<link href="/assets/a.css">`); ok {
		t.Fatal("a stylesheet is not a script")
	}
	if _, ok := firstAssetScript("not found"); ok {
		t.Fatal("found a script in a not-found note")
	}
}

func TestCheckClientIndex(t *testing.T) {
	cases := []struct {
		name   string
		status int
		ct     string
		body   string
		want   string // substring of the error, "" for success
	}{
		{"ok", 200, "text/html; charset=utf-8", sampleIndex, ""},
		{"placeholder 404", 404, "text/plain", "browser client not included", "answered 404"},
		{"wrong type", 200, "application/json", sampleIndex, "Content-Type"},
		{"no type", 200, "", sampleIndex, "Content-Type"},
		{"no module script", 200, "text/html", `<script src="/assets/a.js"></script>`, "module"},
		{"no assets", 200, "text/html", `<script type="module" src="/x.js"></script>`, "/assets/"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			script, err := checkClientIndex(c.status, c.ct, c.body)
			if c.want == "" {
				if err != nil || script != "/assets/index-AbC123_x.js" {
					t.Fatalf("got %q, %v", script, err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want it to contain %q", err, c.want)
			}
		})
	}
}

func TestValidateBrowserClient(t *testing.T) {
	one := []string{"bin"}
	cases := []struct {
		name string
		in   invocation
		ok   bool
	}{
		{"plain", invocation{args: one, browserClient: true}, true},
		{"with upgrade", invocation{args: one, browserClient: true, upgrade: true, from: "old"}, false},
		{"with drills", invocation{args: one, browserClient: true, drills: true}, false},
		{"with docker", invocation{args: one, browserClient: true, docker: true}, false},
	}
	for _, c := range cases {
		if err := c.in.validate(); (err == nil) != c.ok {
			t.Errorf("%s: validate() = %v, want ok=%v", c.name, err, c.ok)
		}
	}
}
