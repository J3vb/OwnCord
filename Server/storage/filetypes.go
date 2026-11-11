package storage

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode"
)

// DefaultBlockedExtensions is upload.blocked_extensions when unset: scripts,
// installers, shortcuts, disk images, web pages and SVG, macro Office documents
// and launchers. Most have no magic signature for ValidateFileType to catch.
var DefaultBlockedExtensions = []string{
	"bat", "cmd", "ps1", "psm1", "ps1xml", "vbs", "vbe", "js", "jse", "wsf", "wsh", "wsc",
	"sct", "hta", "scr", "msi", "msp", "msc", "msix", "msixbundle", "appx", "appxbundle",
	"appinstaller", "application", "jar", "reg", "cpl", "com", "pif", "gadget", "inf",
	"lnk", "url", "scf", "settingcontent-ms", "chm", "iso", "img", "vhd", "vhdx", "exe", "dll",
	"ws", "appref-ms", "library-ms", "searchconnector-ms", "rdp", "diagcab",
	"html", "htm", "xhtml", "xht", "shtml", "mht", "mhtml", "svg", "svgz",
	"sh", "docm", "xlsm", "desktop", "command",
}

const maxExtensionLen = 32

// FileTypePolicy is the owner's upload policy by extension. It can only narrow
// what ValidateFileType allows; the magic-byte blocks in Save always apply.
type FileTypePolicy struct {
	// Blocked extensions are refused as the final extension of the name.
	Blocked []string
	// Allowed, when non-empty, switches on allow-only mode: the final
	// extension must be listed. A blocked extension stays blocked.
	Allowed []string
}

// Check refuses filename when the policy blocks it, with ValidateFileType's
// "blocked file type:" error shape. Only the final extension counts (it picks
// the program Windows opens the file with): report.pdf.bat is refused,
// report.bat.pdf is not. Matching ignores case and trailing dots and spaces,
// which Windows drops on save.
func (p FileTypePolicy) Check(filename string) error {
	name := strings.ToLower(strings.TrimRight(filename, ". "))
	_, rawExt, found := strings.CutLast(name, ".")
	if !found {
		if len(p.Allowed) == 0 {
			return nil
		}
		return errors.New("blocked file type: no file extension")
	}
	ext := strings.TrimSpace(rawExt)
	if slices.Contains(p.Blocked, ext) || len(p.Allowed) > 0 && !slices.Contains(p.Allowed, ext) {
		return fmt.Errorf("blocked file type: .%s", ext)
	}
	return nil
}

// ParseExtensionList parses the admin panel's list: comma- or whitespace-separated, dots optional.
func ParseExtensionList(s string) ([]string, error) {
	return NormalizeExtensions(strings.FieldsFunc(s, func(r rune) bool { return r == ',' || unicode.IsSpace(r) }))
}

// NormalizeExtensions lower-cases entries, strips leading dots and drops blanks
// and duplicates. An entry that cannot be one extension (only dots, a separator,
// a space or invisible character, or over 32 bytes) is an error, not a silent non-match.
func NormalizeExtensions(list []string) ([]string, error) {
	out := make([]string, 0, len(list))
	for _, raw := range list {
		trimmed := strings.TrimSpace(raw)
		ext := strings.ToLower(strings.TrimLeft(trimmed, "."))
		if trimmed == "" || slices.Contains(out, ext) {
			continue
		}
		if ext == "" || len(ext) > maxExtensionLen || strings.ContainsFunc(ext, func(r rune) bool {
			return strings.ContainsRune(`./\:,`, r) || unicode.IsSpace(r) || unicode.IsControl(r) || unicode.In(r, unicode.Cf)
		}) {
			return nil, fmt.Errorf("%q is not a file extension", raw)
		}
		out = append(out, ext)
	}
	return out, nil
}
