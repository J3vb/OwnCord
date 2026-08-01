package admin_test

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/owncord/server/permissions"
)

// The admin panel's role editor renders one checkbox per permission bit from a
// PERM_GROUPS literal in the static HTML. Nothing compiles that literal, so a
// bit added to permissions.AllPerms without being added there becomes silently
// ungrantable through the panel — the role editor would quietly clear it on
// every save, because collectRolePerms rebuilds the mask from the boxes it
// rendered. These tests are the only thing tying the two together.

var permGroupsBlockRe = regexp.MustCompile(`(?s)const PERM_GROUPS=\[(.*?)\n\];`)

// permGridBits extracts the bit values the panel's permission grid renders.
func permGridBits(t *testing.T) []int64 {
	t.Helper()
	source, err := os.ReadFile("static/index.html")
	if err != nil {
		t.Fatalf("read admin panel: %v", err)
	}
	block := permGroupsBlockRe.FindSubmatch(source)
	if block == nil {
		t.Fatal("PERM_GROUPS literal not found in static/index.html")
	}
	// Each entry is [0x…,'Label','Description'].
	entryRe := regexp.MustCompile(`\[(0x[0-9a-fA-F]+),'`)
	matches := entryRe.FindAllSubmatch(block[1], -1)
	if len(matches) == 0 {
		t.Fatal("PERM_GROUPS contains no permission entries")
	}
	bits := make([]int64, 0, len(matches))
	for _, m := range matches {
		bit, err := strconv.ParseInt(strings.TrimPrefix(string(m[1]), "0x"), 16, 64)
		if err != nil {
			t.Fatalf("unparseable bit %q: %v", m[1], err)
		}
		bits = append(bits, bit)
	}
	return bits
}

func TestAdminPanelPermGridCoversEveryPermissionBit(t *testing.T) {
	var mask int64
	for _, bit := range permGridBits(t) {
		mask |= bit
	}
	if mask != permissions.AllPerms {
		missing := permissions.AllPerms &^ mask
		extra := mask &^ permissions.AllPerms
		t.Errorf("panel permission grid mask = %#x, want %#x (missing %#x, undefined %#x)",
			mask, permissions.AllPerms, missing, extra)
	}
}

func TestAdminPanelPermGridHasNoDuplicateOrCompositeBits(t *testing.T) {
	seen := make(map[int64]bool)
	for _, bit := range permGridBits(t) {
		// A checkbox must map to exactly one bit: collectRolePerms ORs the
		// checked values together, so a composite entry would grant several
		// permissions from one box and could not express clearing just one.
		if bit&(bit-1) != 0 {
			t.Errorf("permission grid entry %#x sets more than one bit", bit)
		}
		if seen[bit] {
			t.Errorf("permission grid lists bit %#x (%s) twice", bit, permissions.Name(bit))
		}
		seen[bit] = true
	}
	if len(seen) != len(permGridBits(t)) {
		t.Errorf("permission grid has %d entries but %d distinct bits", len(permGridBits(t)), len(seen))
	}
}

// ─── Override matrix ─────────────────────────────────────────────────────────

var overrideBitsBlockRe = regexp.MustCompile(`(?s)const OVERRIDE_BITS=\[(.*?)\n\];`)

// overrideMatrixBits extracts the bits the channel-permission matrix editor
// renders one tri-state row for.
func overrideMatrixBits(t *testing.T) []int64 {
	t.Helper()
	source, err := os.ReadFile("static/index.html")
	if err != nil {
		t.Fatalf("read admin panel: %v", err)
	}
	block := overrideBitsBlockRe.FindSubmatch(source)
	if block == nil {
		t.Fatal("OVERRIDE_BITS literal not found in static/index.html")
	}
	entryRe := regexp.MustCompile(`\[(0x[0-9a-fA-F]+),'`)
	matches := entryRe.FindAllSubmatch(block[1], -1)
	if len(matches) == 0 {
		t.Fatal("OVERRIDE_BITS contains no entries")
	}
	bits := make([]int64, 0, len(matches))
	for _, m := range matches {
		bit, err := strconv.ParseInt(strings.TrimPrefix(string(m[1]), "0x"), 16, 64)
		if err != nil {
			t.Fatalf("unparseable bit %q: %v", m[1], err)
		}
		bits = append(bits, bit)
	}
	return bits
}

// The matrix covers exactly the bits a CHANNEL override can meaningfully carry.
// Server-wide bits are deliberately absent: an override on MANAGE_ROLES would
// write a mask nothing ever resolves.
func TestAdminPanelOverrideMatrixCoversChannelScopedBits(t *testing.T) {
	want := permissions.ReadMessages | permissions.SendMessages | permissions.AttachFiles |
		permissions.AddReactions | permissions.ManageMessages | permissions.MentionEveryone |
		permissions.ConnectVoice | permissions.SpeakVoice | permissions.UseVideo |
		permissions.ShareScreen

	var mask int64
	for _, bit := range overrideMatrixBits(t) {
		mask |= bit
	}
	if mask != want {
		t.Errorf("override matrix mask = %#x, want %#x (missing %#x, extra %#x)",
			mask, want, want&^mask, mask&^want)
	}
}

func TestAdminPanelOverrideMatrixHasSingleDefinedBits(t *testing.T) {
	seen := make(map[int64]bool)
	for _, bit := range overrideMatrixBits(t) {
		// collectOverrideMasks ORs each checked row's bit into one of the two
		// masks, so a composite row could not express clearing just one bit.
		if bit&(bit-1) != 0 {
			t.Errorf("override matrix entry %#x sets more than one bit", bit)
		}
		if bit&permissions.AllPerms != bit {
			t.Errorf("override matrix entry %#x is not a defined permission bit", bit)
		}
		if seen[bit] {
			t.Errorf("override matrix lists bit %#x (%s) twice", bit, permissions.Name(bit))
		}
		seen[bit] = true
	}
}
