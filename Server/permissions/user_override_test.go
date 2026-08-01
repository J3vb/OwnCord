package permissions

import (
	"context"
	"errors"
	"testing"
)

// ─── Resolution precedence ───────────────────────────────────────────────────
//
// Discord's order is: base role permissions -> role override -> user override.
// Within a layer allow beats deny; across layers the later (narrower) layer
// wins. These cases pin every crossing of the two rules, because getting one
// of them backwards is exactly how a "private" channel leaks.

func TestEffectiveChannelPerms_ResolutionOrder(t *testing.T) {
	tests := []struct {
		name string
		base int64
		o    ChannelOverride
		perm int64
		want bool
	}{
		{
			name: "base grant with no overrides",
			base: ReadMessages | SendMessages,
			perm: SendMessages,
			want: true,
		},
		{
			name: "role deny strips a base grant",
			base: ReadMessages | SendMessages,
			o:    ChannelOverride{Deny: SendMessages},
			perm: SendMessages,
			want: false,
		},
		{
			name: "role allow adds a bit the base lacks",
			base: ReadMessages,
			o:    ChannelOverride{Allow: SendMessages},
			perm: SendMessages,
			want: true,
		},
		{
			name: "user deny beats a role allow",
			base: ReadMessages,
			o:    ChannelOverride{Allow: SendMessages, UserDeny: SendMessages},
			perm: SendMessages,
			want: false,
		},
		{
			name: "user deny beats a base grant",
			base: ReadMessages | SendMessages,
			o:    ChannelOverride{UserDeny: SendMessages},
			perm: SendMessages,
			want: false,
		},
		{
			name: "user allow beats a role deny",
			base: ReadMessages | SendMessages,
			o:    ChannelOverride{Deny: SendMessages, UserAllow: SendMessages},
			perm: SendMessages,
			want: true,
		},
		{
			name: "user allow grants a bit neither the base nor the role has",
			base: ReadMessages,
			o:    ChannelOverride{UserAllow: SendMessages},
			perm: SendMessages,
			want: true,
		},
		{
			name: "user allow beats user deny on the same bit",
			base: ReadMessages,
			o:    ChannelOverride{UserAllow: SendMessages, UserDeny: SendMessages},
			perm: SendMessages,
			want: true,
		},
		{
			name: "user deny of READ hides a channel a role allow revealed",
			base: 0,
			o:    ChannelOverride{Allow: ReadMessages, UserDeny: ReadMessages},
			perm: ReadMessages,
			want: false,
		},
		{
			name: "layers are independent per bit",
			base: ReadMessages | SendMessages,
			o:    ChannelOverride{UserDeny: SendMessages},
			perm: ReadMessages,
			want: true,
		},
		{
			name: "multi-bit check is ALL-of",
			base: ReadMessages | SendMessages,
			o:    ChannelOverride{UserDeny: SendMessages},
			perm: ReadMessages | SendMessages,
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			eff := EffectiveChannelPerms(tt.base, tt.o)
			if got := eff&tt.perm == tt.perm; got != tt.want {
				t.Errorf("EffectiveChannelPerms(0x%X, %+v)&0x%X = %v, want %v",
					tt.base, tt.o, tt.perm, got, tt.want)
			}
		})
	}
}

// An ADMINISTRATOR role bypasses BOTH layers. The bypass lives at the call
// site, not inside EffectiveChannelPerms, so this is asserted through the
// Checker — the surface every caller actually uses.
func TestHasChannelPerm_AdminBypassesUserOverride(t *testing.T) {
	mock := newMockDB()
	mock.userPerms[chanUserKey{10, 7}] = chanPerm{deny: ReadMessages | SendMessages}
	ck := NewChecker(mock)

	if !ck.HasChannelPerm(context.Background(), Administrator, 1, 7, 10, ReadMessages|SendMessages) {
		t.Error("ADMINISTRATOR must bypass a per-user deny")
	}
	if !ck.HasChannelPermBatch(Administrator, map[int64]ChannelOverride{
		10: {UserDeny: ReadMessages},
	}, 10, ReadMessages) {
		t.Error("ADMINISTRATOR must bypass a per-user deny in the batch path too")
	}
}

func TestHasChannelPerm_AppliesUserLayer(t *testing.T) {
	const (
		chID   = 10
		roleID = int64(4)
		aliceI = int64(7)
		bobID  = int64(8)
	)
	mock := newMockDB()
	// The role may read but not send here.
	mock.channelPerms[chanRoleKey{chID, roleID}] = chanPerm{deny: SendMessages}
	// Alice is individually granted SEND back; Bob is individually denied READ.
	mock.userPerms[chanUserKey{chID, aliceI}] = chanPerm{allow: SendMessages}
	mock.userPerms[chanUserKey{chID, bobID}] = chanPerm{deny: ReadMessages}
	ck := NewChecker(mock)

	base := ReadMessages | SendMessages
	ctx := context.Background()

	if !ck.HasChannelPerm(ctx, base, roleID, aliceI, chID, SendMessages) {
		t.Error("alice: user allow must beat the role deny")
	}
	if ck.HasChannelPerm(ctx, base, roleID, bobID, chID, ReadMessages) {
		t.Error("bob: user deny must beat the base READ grant")
	}
	// A third member with no user override falls back to the role verdict.
	if ck.HasChannelPerm(ctx, base, roleID, 99, chID, SendMessages) {
		t.Error("carol: role deny still applies without a user override")
	}
	if !ck.HasChannelPerm(ctx, base, roleID, 99, chID, ReadMessages) {
		t.Error("carol: base READ still applies without a user override")
	}
}

// userID 0 means "no member in hand" — the per-user layer is skipped rather
// than queried for an id that cannot exist.
func TestHasChannelPerm_ZeroUserSkipsUserLayer(t *testing.T) {
	mock := newMockDB()
	mock.userPerms[chanUserKey{10, 0}] = chanPerm{deny: ReadMessages}
	ck := NewChecker(mock)

	if !ck.HasChannelPerm(context.Background(), ReadMessages, 4, 0, 10, ReadMessages) {
		t.Error("userID 0 must not consult channel_user_overrides")
	}
}

// A failed per-user lookup must deny, exactly as a failed per-role lookup does:
// substituting a zero override would restore every bit a user deny stripped.
func TestHasChannelPerm_UserLookupErrorDenies(t *testing.T) {
	mock := newMockDB()
	mock.userErr = errors.New("boom")
	ck := NewChecker(mock)

	if ck.HasChannelPerm(context.Background(), ReadMessages, 4, 7, 10, ReadMessages) {
		t.Error("a per-user override lookup failure must fail closed")
	}
}

func TestVisibleChannelIDs_UserOverrideLayer(t *testing.T) {
	ck := NewChecker(newMockDB())
	channels := []ChannelRef{
		{ID: 1, Type: "text"},
		{ID: 2, Type: "text"},
		{ID: 3, Type: "voice"},
	}
	overrides := map[int64]ChannelOverride{
		// Role can read #2, but this member is individually denied.
		2: {UserDeny: ReadMessages},
		// Role is denied #3, but this member is individually allowed.
		3: {Deny: ReadMessages, UserAllow: ReadMessages},
	}

	got := ck.VisibleChannelIDs(ReadMessages, channels, overrides)
	if !got[1] {
		t.Error("channel 1 (no override) must be visible")
	}
	if got[2] {
		t.Error("channel 2 must be hidden by the per-user deny")
	}
	if !got[3] {
		t.Error("channel 3 must be revealed by the per-user allow")
	}
}
