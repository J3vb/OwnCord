package safefetch

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Policy.Classify, Policy.Resolve and Policy.Dial replace the boundary rather
// than configure it: a call site that sets one has opted out of the address
// policy, the resolver, or the connect. They exist for tests that must reach
// an httptest server on loopback, and for B7 to layer its own rule on top.
//
// This walks the whole server tree and fails if any production file sets one,
// so "no production call site overrides the boundary" is a checked fact
// rather than a comment. A future caller that genuinely needs one should
// delete its name from this test in the same commit, with the reason in the
// commit message — which is the point: it becomes visible.
func TestNoProductionOverrideOfSeams(t *testing.T) {
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}
	seams := []string{"Classify:", "Resolve:", "Dial:"}
	err = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if name := d.Name(); name == "vendor" || name == "testdata" || strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		text := string(src)
		if !strings.Contains(text, "safefetch.Policy{") && !strings.Contains(text, "Policy{") {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		for i, line := range strings.Split(text, "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") {
				continue
			}
			for _, seam := range seams {
				if strings.HasPrefix(trimmed, seam) {
					t.Errorf("%s:%d sets safefetch's %s seam in production code — that replaces the destination boundary, and only a _test.go file may do it",
						filepath.ToSlash(rel), i+1, strings.TrimSuffix(seam, ":"))
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

// Policy.ContentTypes empty disables the media-type check. That is a real
// option — a caller that treats the body as opaque bytes has no type to
// allow — but no call site in this repository is one, and a policy that
// silently grew a gap by omission is exactly the failure this package exists
// to prevent. Every production Policy literal has to name it.
func TestEveryProductionPolicyNamesContentTypes(t *testing.T) {
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}
	err = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if name := d.Name(); name == "vendor" || name == "testdata" || strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		for _, literal := range policyLiterals(string(src)) {
			if !strings.Contains(literal, "ContentTypes:") {
				t.Errorf("%s has a safefetch.Policy literal with no ContentTypes — an empty allowlist accepts any media type",
					filepath.ToSlash(rel))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

// inComment reports whether the offset sits on a `//` comment line — the
// package doc's usage example is a Policy literal that compiles nothing.
func inComment(src string, at int) bool {
	start := strings.LastIndexByte(src[:at], '\n') + 1
	return strings.HasPrefix(strings.TrimSpace(src[start:at]), "//")
}

// policyLiterals returns the text of every `safefetch.Policy{...}` composite
// literal in src, brace-matched. Crude on purpose: it needs to find the
// literals, not parse Go.
func policyLiterals(src string) []string {
	const open = "safefetch.Policy{"
	var out []string
	for i := strings.Index(src, open); i >= 0; {
		depth, end := 0, -1
		for j := i + len(open) - 1; j < len(src); j++ {
			switch src[j] {
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					end = j
				}
			}
			if end >= 0 {
				break
			}
		}
		if end < 0 {
			break
		}
		if !inComment(src, i) {
			out = append(out, src[i:end+1])
		}
		next := strings.Index(src[end:], open)
		if next < 0 {
			break
		}
		i = end + next
	}
	return out
}

// A Policy's slice fields alias the caller's arrays. New copies them, so a
// caller that reuses or mutates its Policy value afterwards cannot widen what
// an existing Fetcher accepts.
func TestNew_CopiesPolicySlices(t *testing.T) {
	schemes := []string{"https"}
	types := []string{"application/json"}
	ports := []int{443}
	f, err := New(Policy{
		Schemes:              schemes,
		Ports:                ports,
		ContentTypes:         types,
		MaxRedirects:         1,
		Deadline:             time.Second,
		MaxBytes:             1 << 10,
		MaxDecompressedBytes: 1 << 10,
		MaxConcurrent:        1,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	schemes[0] = "http"
	types[0] = "text/html"
	ports[0] = 8080

	if slices.Contains(f.policy.Schemes, "http") {
		t.Error("mutating the caller's Schemes slice changed the Fetcher's")
	}
	if f.typeAllowed("text/html") {
		t.Error("mutating the caller's ContentTypes slice changed the Fetcher's")
	}
	if slices.Contains(f.ports, 8080) {
		t.Error("mutating the caller's Ports slice changed the Fetcher's")
	}
}
