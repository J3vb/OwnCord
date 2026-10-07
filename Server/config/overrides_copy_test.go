package config

import (
	"strings"
	"testing"
)

// Every panel-editable key must ship complete owner-facing copy, and the table
// must not carry copy for a key the panel cannot edit.
func TestSettingCopy_CoversEveryEditableKey(t *testing.T) {
	for _, key := range EditableKeys() {
		c, ok := SettingCopyFor(key)
		if !ok {
			t.Errorf("%s: no setting copy", key)
			continue
		}
		fields := map[string]string{
			"Label": c.Label, "Description": c.Description,
			"Recommended": c.Recommended, "Effect": c.Effect,
		}
		for name, v := range fields {
			if strings.TrimSpace(v) == "" {
				t.Errorf("%s: %s is empty", key, name)
			}
			if strings.ContainsAny(v, "\r\n") {
				t.Errorf("%s: %s must be one line", key, name)
			}
		}
		if c.Label == key {
			t.Errorf("%s: Label must be plain words, not the dotted key", key)
		}
		if len(c.Label) > 48 {
			t.Errorf("%s: Label is %d chars, want <= 48", key, len(c.Label))
		}
		if len(c.Description) > 160 {
			t.Errorf("%s: Description is %d chars, want <= 160 (one short line)", key, len(c.Description))
		}
	}
	for key := range settingCopy {
		if !IsEditable(key) {
			t.Errorf("settingCopy has copy for non-editable key %q", key)
		}
	}
}

func TestSettingCopy_LabelsAreUnique(t *testing.T) {
	seen := map[string]string{}
	for _, key := range EditableKeys() {
		c, _ := SettingCopyFor(key)
		if other, dup := seen[c.Label]; dup {
			t.Errorf("label %q used by both %s and %s", c.Label, other, key)
		}
		seen[c.Label] = key
	}
}
