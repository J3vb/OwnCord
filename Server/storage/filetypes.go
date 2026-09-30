package storage

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode"
)

// DefaultBlockedExtensions is upload.blocked_extensions when config.yaml does
// not set it: Windows scripts, installers, shortcuts and disk images that run
// or mount on a double-click. Most are plain text with no magic signature for
// ValidateFileType to catch; the rest (exe, dll, msi) are also caught there.
var DefaultBlockedExtensions = []string{
	"bat", "cmd", "ps1", "psm1", "ps1xml", "vbs", "vbe", "js", "jse", "wsf", "wsh", "wsc",
	"sct", "hta", "scr", "msi", "msp", "msc", "msix", "msixbundle", "appx", "appxbundle",
	"appinstaller", "application", "jar", "reg", "cpl", "com", "pif", "gadget", "inf",
	"lnk", "url", "scf", "settingcontent-ms", "chm", "iso", "img", "vhd", "vhdx", "exe", "dll",
}

// maxExtensionLen bounds one list entry, so a list stays a list of extensions.
const maxExtensionLen = 32

// FileTypePolicy is the owner's upload policy by file extension. It narrows
// what ValidateFileType allows and can never widen it: the magic-byte blocks
// in Save apply to every file whatever its name.
type FileTypePolicy struct {
	// Blocked extensions are refused wherever they appear in the name.
	Blocked []string
	// Allowed, when non-empty, switches on allow-only mode: the final
	// extension must be listed. A blocked extension stays blocked.
	Allowed []string
}

// Check refuses filename when the policy blocks it, with the same "blocked
// file type:" error shape as ValidateFileType. Matching is case-insensitive
// and sees every extension in the name, so report.pdf.bat and report.bat.pdf
// are both refused for bat; trailing dots and spaces, which Windows drops
// when it saves the file, are ignored.
func (p FileTypePolicy) Check(filename string) error {
	parts := strings.Split(strings.ToLower(strings.TrimRight(filename, ". ")), ".")
	exts := parts[1:]
	for _, ext := range exts {
		if ext = strings.TrimSpace(ext); slices.Contains(p.Blocked, ext) {
			return fmt.Errorf("blocked file type: .%s", ext)
		}
	}
	if len(p.Allowed) == 0 {
		return nil
	}
	if len(exts) == 0 {
		return errors.New("blocked file type: no file extension")
	}
	if final := strings.TrimSpace(exts[len(exts)-1]); !slices.Contains(p.Allowed, final) {
		return fmt.Errorf("blocked file type: .%s", final)
	}
	return nil
}

// ParseExtensionList parses an extension list as the admin panel sends it:
// entries separated by commas or whitespace, each with or without its dot.
func ParseExtensionList(s string) ([]string, error) {
	return NormalizeExtensions(strings.FieldsFunc(s, func(r rune) bool { return r == ',' || unicode.IsSpace(r) }))
}

// NormalizeExtensions lower-cases each entry and strips its leading dots,
// dropping empty entries and duplicates. An entry that cannot be one
// extension (a dot, a path or stream separator, a space or an invisible
// character inside it, or over 32 bytes) is an error rather than an entry
// that silently never matches.
func NormalizeExtensions(list []string) ([]string, error) {
	out := make([]string, 0, len(list))
	for _, raw := range list {
		ext := strings.ToLower(strings.TrimLeft(strings.TrimSpace(raw), "."))
		if ext == "" || slices.Contains(out, ext) {
			continue
		}
		if len(ext) > maxExtensionLen || strings.ContainsFunc(ext, func(r rune) bool {
			return strings.ContainsRune(`./\:,`, r) || unicode.IsSpace(r) || unicode.IsControl(r) || unicode.In(r, unicode.Cf)
		}) {
			return nil, fmt.Errorf("%q is not a file extension", raw)
		}
		out = append(out, ext)
	}
	return out, nil
}
