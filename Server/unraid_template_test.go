package main

// The Unraid Community Apps template (deploy/unraid/owncord.xml) is hand-written
// XML that Unraid parses at install time, so a wrong port, a single-file mount
// or a missing --user only shows up on someone's server. This pins the parts
// that must agree with the image: the image name, the bundled-LiveKit ports,
// the 99:100 appdata ownership and a config.yaml that need not pre-exist.

import (
	"encoding/xml"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

type unraidConfig struct {
	Name   string `xml:"Name,attr"`
	Target string `xml:"Target,attr"`
	Mode   string `xml:"Mode,attr"`
	Type   string `xml:"Type,attr"`
	Value  string `xml:",chardata"`
}

type unraidTemplate struct {
	Repository  string         `xml:"Repository"`
	WebUI       string         `xml:"WebUI"`
	ExtraParams string         `xml:"ExtraParams"`
	Support     string         `xml:"Support"`
	Icon        string         `xml:"Icon"`
	Network     string         `xml:"Network"`
	Shell       string         `xml:"Shell"`
	Configs     []unraidConfig `xml:"Config"`
}

func TestUnraidTemplateMatchesImage(t *testing.T) {
	var tpl unraidTemplate
	if err := xml.Unmarshal([]byte(readFile(t, "../deploy/unraid/owncord.xml")), &tpl); err != nil {
		t.Fatalf("template is not valid XML: %v", err)
	}

	var compose composeFile
	if err := yaml.Unmarshal([]byte(readFile(t, "docker-compose.yml")), &compose); err != nil {
		t.Fatal(err)
	}
	if want, _, _ := strings.Cut(compose.Services["owncord"].Image, ":"); !strings.HasPrefix(tpl.Repository, want) {
		t.Errorf("Repository %q must be the compose image %q", tpl.Repository, want)
	}

	ports := map[string]string{}
	paths := map[string]unraidConfig{}
	for _, c := range tpl.Configs {
		switch c.Type {
		case "Port":
			ports[c.Target+"/"+strings.ToLower(c.Mode)] = c.Value
		case "Path":
			paths[c.Target] = c
		}
	}
	for _, p := range []string{"8443/tcp", "7881/tcp", "7882/udp"} {
		if ports[p] == "" {
			t.Errorf("missing published port %s (have %v)", p, ports)
		}
	}

	// A bind-mounted config.yaml that does not exist yet becomes a directory
	// and breaks boot, so mount the directory the server writes it into.
	for target, c := range paths {
		if strings.HasSuffix(target, ".yaml") {
			t.Errorf("Path %q mounts a single file; mount /app so config.yaml is created on first start", target)
		}
		if !strings.HasPrefix(c.Value, "/mnt/user/appdata/") {
			t.Errorf("Path %q default %q must live under /mnt/user/appdata", target, c.Value)
		}
	}
	for _, target := range []string{"/app", "/app/data"} {
		if _, ok := paths[target]; !ok {
			t.Errorf("missing appdata Path for %s", target)
		}
	}

	// The image runs as 65532, but Unraid creates appdata as 99:100, so the
	// container must run as that user (and /app, which holds config.yaml, is
	// then the appdata mount, not the root-owned image dir).
	if !strings.Contains(tpl.ExtraParams, "--user 99:100") {
		t.Errorf("ExtraParams %q must run the container as 99:100", tpl.ExtraParams)
	}
	// Unraid's Console action runs this shell in the container; the distroless
	// image has none, so naming one makes that action fail.
	if tpl.Shell != "" {
		t.Errorf("Shell %q must be empty: the image has no shell", tpl.Shell)
	}
	if !strings.HasSuffix(tpl.WebUI, "[PORT:8443]/admin") {
		t.Errorf("WebUI %q must point at the admin panel", tpl.WebUI)
	}
	if !strings.HasPrefix(tpl.Support, "https://github.com/J3vb/OwnCord") || !strings.HasPrefix(tpl.Icon, "https://") {
		t.Errorf("Support %q and Icon %q must be https URLs", tpl.Support, tpl.Icon)
	}
}
