package permissions_test

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// TestSchemaDocBitMapCoversEveryPermissionBit is the doc half of the B5-8
// four-file bit (HP-5 review): TestAdminPanelPermGridCoversEveryPermissionBit
// (Server/admin/perm_grid_test.go) checks the admin panel's permission grid
// against permissions.AllPerms; this checks docs/schema.md's "Bit Map" table and its
// "reserved" line against the same source of truth, so a bit added to
// permissions.go without updating the doc — or left on the reserved line —
// fails here instead of shipping a stale contract.
//
// RUN WITH -count=1: docs/schema.md lives outside this module, so Go's test
// cache does not track it as an input.
func TestSchemaDocBitMapCoversEveryPermissionBit(t *testing.T) {
	raw, err := os.ReadFile("../../docs/schema.md")
	if err != nil {
		t.Fatalf("read docs/schema.md: %v", err)
	}
	doc := string(raw)

	rowRe := regexp.MustCompile("(?m)^\\|\\s*(\\d+)\\s*\\|\\s*`0[xX][0-9A-Fa-f]+`\\s*\\|\\s*`([A-Z_]+)`\\s*\\|")
	matches := rowRe.FindAllStringSubmatch(doc, -1)
	if len(matches) < 15 {
		t.Fatalf("found only %d bit-map rows in docs/schema.md; the table regex may no longer match (vacuity guard)", len(matches))
	}
	documented := make(map[int64]string, len(matches))
	for _, m := range matches {
		n, err := strconv.ParseInt(m[1], 10, 64)
		if err != nil {
			t.Fatalf("bit-map row bit %q: %v", m[1], err)
		}
		documented[n] = m[2]
	}

	reservedRe := regexp.MustCompile(`Bits ([0-9,\- ]+) are reserved\.`)
	reservedMatch := reservedRe.FindStringSubmatch(doc)
	if reservedMatch == nil {
		t.Fatal("docs/schema.md has no \"Bits ... are reserved.\" line; the regex may no longer match (vacuity guard)")
	}
	reserved := map[int64]bool{}
	for part := range strings.SplitSeq(reservedMatch[1], ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if lo, hi, ok := strings.Cut(part, "-"); ok {
			loN, err1 := strconv.ParseInt(strings.TrimSpace(lo), 10, 64)
			hiN, err2 := strconv.ParseInt(strings.TrimSpace(hi), 10, 64)
			if err1 != nil || err2 != nil {
				t.Fatalf("unparseable reserved range %q", part)
			}
			for n := loN; n <= hiN; n++ {
				reserved[n] = true
			}
			continue
		}
		n, err := strconv.ParseInt(part, 10, 64)
		if err != nil {
			t.Fatalf("unparseable reserved bit %q", part)
		}
		reserved[n] = true
	}

	for bit := range int64(63) {
		mask := int64(1) << uint(bit)
		if permissions.AllPerms&mask == 0 {
			continue
		}
		name, ok := documented[bit]
		if !ok {
			t.Errorf("bit %d (%s) is in permissions.AllPerms but has no row in docs/schema.md's Bit Map table", bit, permissions.Name(mask))
			continue
		}
		if name != permissions.Name(mask) {
			t.Errorf("bit %d documented as %q, want %q (permissions.Name)", bit, name, permissions.Name(mask))
		}
		if reserved[bit] {
			t.Errorf("bit %d (%s) is both defined in permissions.AllPerms and listed on the reserved-bits line", bit, permissions.Name(mask))
		}
	}
}

// TestClientPermissionEnumHasModerateMembers is the client half of the
// four-file bit (HP-5 review): Client/tests/contract/ has no existing
// pattern that checks Client/src/lib/types.ts's Permission enum against the
// server's permission constants, so this greps for the exact declaration
// instead — the same shape as the admin-panel HTML check, applied to the
// other generated-by-hand surface. A bit added to permissions.go without the
// matching TypeScript line fails here.
func TestClientPermissionEnumHasModerateMembers(t *testing.T) {
	raw, err := os.ReadFile("../../Client/src/lib/types.ts")
	if err != nil {
		t.Fatalf("read Client/src/lib/types.ts: %v", err)
	}
	if !regexp.MustCompile(`(?m)^\s*MODERATE_MEMBERS\s*=\s*0x400000\s*,?\s*$`).Match(raw) {
		t.Error("Client/src/lib/types.ts's Permission enum has no `MODERATE_MEMBERS = 0x400000` line")
	}
}

// TestClientPermissionEnumHasManageNicknames is the client half of the
// MANAGE_NICKNAMES bit (WP 6.4a): the Permission enum must carry the same
// value the server defines.
func TestClientPermissionEnumHasManageNicknames(t *testing.T) {
	raw, err := os.ReadFile("../../Client/src/lib/types.ts")
	if err != nil {
		t.Fatalf("read Client/src/lib/types.ts: %v", err)
	}
	if !regexp.MustCompile(`(?m)^\s*MANAGE_NICKNAMES\s*=\s*0x800000\s*,?\s*$`).Match(raw) {
		t.Error("Client/src/lib/types.ts's Permission enum has no `MANAGE_NICKNAMES = 0x800000` line")
	}
}

// TestClientPermissionEnumHasMoveMembers is the client half of the
// MOVE_MEMBERS bit (WP 8.4a): the Permission enum must carry the same value
// the server defines.
func TestClientPermissionEnumHasMoveMembers(t *testing.T) {
	raw, err := os.ReadFile("../../Client/src/lib/types.ts")
	if err != nil {
		t.Fatalf("read Client/src/lib/types.ts: %v", err)
	}
	if !regexp.MustCompile(`(?m)^\s*MOVE_MEMBERS\s*=\s*0x2000\s*,?\s*$`).Match(raw) {
		t.Error("Client/src/lib/types.ts's Permission enum has no `MOVE_MEMBERS = 0x2000` line")
	}
}

// TestClientPermissionEnumHasManageBackups is the client half of the
// MANAGE_BACKUPS bit (WP 8.4c): the Permission enum must carry the same value
// the server defines.
func TestClientPermissionEnumHasManageBackups(t *testing.T) {
	raw, err := os.ReadFile("../../Client/src/lib/types.ts")
	if err != nil {
		t.Fatalf("read Client/src/lib/types.ts: %v", err)
	}
	if !regexp.MustCompile(`(?m)^\s*MANAGE_BACKUPS\s*=\s*0x4000\s*,?\s*$`).Match(raw) {
		t.Error("Client/src/lib/types.ts's Permission enum has no `MANAGE_BACKUPS = 0x4000` line")
	}
}

// TestClientPermissionEnumHasOwnerTypeBits is the client half of WP 8.4d's
// seven owner-type bits: the Permission enum must carry the same values the
// server defines.
func TestClientPermissionEnumHasOwnerTypeBits(t *testing.T) {
	raw, err := os.ReadFile("../../Client/src/lib/types.ts")
	if err != nil {
		t.Fatalf("read Client/src/lib/types.ts: %v", err)
	}
	for _, c := range []struct {
		name string
		hex  string
	}{
		{"MANAGE_CONFIG", "0x4"},
		{"MANAGE_UPDATES", "0x8"},
		{"MANAGE_TOKENS", "0x10"},
		{"ISSUE_RECOVERY", "0x80"},
		{"VIEW_DIAGNOSTICS", "0x100"},
		{"RESTORE_BACKUPS", "0x8000"},
		{"ERASE_ACCOUNTS", "0x10000000"},
	} {
		re := regexp.MustCompile(`(?m)^\s*` + c.name + `\s*=\s*` + c.hex + `\s*,?\s*$`)
		if !re.Match(raw) {
			t.Errorf("Client/src/lib/types.ts's Permission enum has no `%s = %s` line", c.name, c.hex)
		}
	}
}
