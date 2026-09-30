package storage_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/storage"
)

// The owner-configurable extension policy: plain-text Windows scripts carry no
// magic signature, so they are refused by name.

func TestFileTypePolicy_DefaultsBlockWindowsScripts(t *testing.T) {
	p := storage.FileTypePolicy{Blocked: storage.DefaultBlockedExtensions}
	for _, name := range []string{
		"run.bat", "run.cmd", "setup.ps1", "mod.psm1", "x.vbs", "x.vbe", "app.js", "x.jse",
		"x.wsf", "x.wsh", "page.hta", "screen.scr", "setup.msi", "pkg.msix", "pkg.appx",
		"app.jar", "keys.reg", "panel.cpl", "old.com", "x.pif", "x.application", "x.gadget",
		"setup.inf", "link.lnk", "site.url", "disk.iso", "disk.img", "disk.vhd", "disk.vhdx",
	} {
		err := p.Check(name)
		if err == nil {
			t.Errorf("Check(%q) = nil, want a blocked file type", name)
			continue
		}
		if !strings.HasPrefix(err.Error(), "blocked file type: ") {
			t.Errorf("Check(%q) = %q, want the blocked file type shape", name, err)
		}
	}
	for _, name := range []string{"photo.png", "notes.txt", "report.pdf", "archive.zip", "README", "v1.2.3.tar.gz"} {
		if err := p.Check(name); err != nil {
			t.Errorf("Check(%q) = %v, want allowed", name, err)
		}
	}
}

func TestFileTypePolicy_CaseAndDoubleExtensions(t *testing.T) {
	p := storage.FileTypePolicy{Blocked: []string{"bat", "js"}}
	for _, name := range []string{
		"RUN.BAT", "Run.Bat", // case-insensitive
		"report.pdf.bat",         // the final extension
		"report.bat.pdf",         // an inner extension
		"evil.bat.", "evil.bat ", // Windows drops trailing dots and spaces
		"evil.bat. . ",
		".bat",
		"lib.min.JS",
	} {
		if err := p.Check(name); err == nil {
			t.Errorf("Check(%q) = nil, want blocked", name)
		}
	}
	if err := p.Check("report.pdf.bat"); err == nil || err.Error() != "blocked file type: .bat" {
		t.Errorf("Check(report.pdf.bat) = %v, want %q", err, "blocked file type: .bat")
	}
	if err := p.Check("batch.txt"); err != nil {
		t.Errorf("Check(batch.txt) = %v, want allowed (the base name is not an extension)", err)
	}
}

func TestFileTypePolicy_AllowOnlyMode(t *testing.T) {
	p := storage.FileTypePolicy{Blocked: []string{"bat"}, Allowed: []string{"png", "pdf"}}
	for _, name := range []string{"a.png", "A.PNG", "doc.pdf", "v1.2.pdf"} {
		if err := p.Check(name); err != nil {
			t.Errorf("Check(%q) = %v, want allowed", name, err)
		}
	}
	for _, name := range []string{"a.txt", "README", "a.png.exe", "a.bat.pdf"} {
		err := p.Check(name)
		if err == nil || !strings.HasPrefix(err.Error(), "blocked file type: ") {
			t.Errorf("Check(%q) = %v, want a blocked file type", name, err)
		}
	}
	// An extension on both lists stays blocked.
	both := storage.FileTypePolicy{Blocked: []string{"js"}, Allowed: []string{"js"}}
	if err := both.Check("a.js"); err == nil {
		t.Error("Check(a.js) with js on both lists = nil, want blocked")
	}
}

func TestParseExtensionList(t *testing.T) {
	got, err := storage.ParseExtensionList(" .BAT, cmd  ps1,,bat\n.Hta ")
	if err != nil {
		t.Fatalf("ParseExtensionList: %v", err)
	}
	if want := []string{"bat", "cmd", "ps1", "hta"}; !slices.Equal(got, want) {
		t.Errorf("ParseExtensionList = %q, want %q", got, want)
	}
	if got, err := storage.ParseExtensionList("  "); err != nil || len(got) != 0 {
		t.Errorf("ParseExtensionList(blank) = %q, %v; want empty, nil", got, err)
	}
	for _, bad := range []string{"tar.gz", "a/b", `a\b`, "a:b", strings.Repeat("x", 33), "a\u202eb"} {
		if _, err := storage.ParseExtensionList(bad); err == nil {
			t.Errorf("ParseExtensionList(%q) = nil error, want invalid", bad)
		}
	}
}

func TestNormalizeExtensions(t *testing.T) {
	got, err := storage.NormalizeExtensions([]string{".EXE", " dll ", "exe", ""})
	if err != nil || !slices.Equal(got, []string{"exe", "dll"}) {
		t.Errorf("NormalizeExtensions = %q, %v; want [exe dll], nil", got, err)
	}
	if _, err := storage.NormalizeExtensions([]string{"a b"}); err == nil {
		t.Error("NormalizeExtensions(a b) = nil error, want invalid")
	}
}
