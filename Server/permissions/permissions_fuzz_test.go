package permissions

import "testing"

// FuzzEffectivePerms checks EffectivePerms(rolePerm, allow, deny) against the
// formula its own doc comment states -- effective = (rolePerm &^ deny) |
// allow -- bit by bit, for arbitrary int64 inputs (not just the defined
// permission bits): a future edit that flips deny/allow precedence, or that
// drops a bit somewhere, shows up as a bit-level mismatch instead of only
// failing on the handful of bits the table tests happen to cover.
func FuzzEffectivePerms(f *testing.F) {
	seeds := []int64{0, -1, AllPerms, Administrator, SendMessages, 0x1, 0x7FFFFFFF, 0x3FFFFFFF}
	for _, a := range seeds {
		for _, b := range seeds {
			for _, c := range seeds {
				f.Add(a, b, c)
			}
		}
	}

	f.Fuzz(func(t *testing.T, rolePerm, allow, deny int64) {
		got := EffectivePerms(rolePerm, allow, deny)

		for bit := range 64 {
			mask := int64(1) << uint(bit)
			gotBit := got&mask != 0
			allowBit := allow&mask != 0
			denyBit := deny&mask != 0
			roleBit := rolePerm&mask != 0

			switch {
			case allowBit:
				// Allow always wins, even against a deny on the same bit.
				if !gotBit {
					t.Fatalf("EffectivePerms(%#x,%#x,%#x): bit %d in allow but clear in result %#x", rolePerm, allow, deny, bit, got)
				}
			case denyBit:
				// Deny (without allow) always clears the bit, regardless of
				// what the base role held.
				if gotBit {
					t.Fatalf("EffectivePerms(%#x,%#x,%#x): bit %d in deny (not allow) but set in result %#x", rolePerm, allow, deny, bit, got)
				}
			default:
				// Untouched by either override: the base role's bit passes
				// through unchanged.
				if gotBit != roleBit {
					t.Fatalf("EffectivePerms(%#x,%#x,%#x): bit %d untouched by overrides, want %v (from base) got %v in result %#x", rolePerm, allow, deny, bit, roleBit, gotBit, got)
				}
			}
		}

		// No-op overrides never change the base.
		if EffectivePerms(rolePerm, 0, 0) != rolePerm {
			t.Fatalf("EffectivePerms(%#x,0,0) = %#x, want %#x unchanged", rolePerm, EffectivePerms(rolePerm, 0, 0), rolePerm)
		}
	})
}

// FuzzEffectiveChannelPerms checks the two-layer resolution
// (base -> role override -> user override) against the ordering its doc
// comment promises: each layer is EffectivePerms, and the layers compose by
// feeding one into the next -- so this locks EffectiveChannelPerms to being
// exactly that composition, not an inlined-and-drifted copy of it, and
// re-derives the "user allow beats everything, user deny beats the role
// layer, role layer beats base" precedence bit by bit.
func FuzzEffectiveChannelPerms(f *testing.F) {
	seeds := []int64{0, -1, AllPerms, Administrator, SendMessages, ReadMessages, 0x1, 0x7FFFFFFF}
	for _, a := range seeds {
		for _, b := range seeds {
			f.Add(a, b, int64(0), int64(0), int64(0))
			f.Add(a, int64(0), b, int64(0), int64(0))
			f.Add(a, int64(0), int64(0), b, int64(0))
			f.Add(a, int64(0), int64(0), int64(0), b)
			f.Add(a, b, b, b, b)
		}
	}

	f.Fuzz(func(t *testing.T, base, allow, deny, userAllow, userDeny int64) {
		o := ChannelOverride{Allow: allow, Deny: deny, UserAllow: userAllow, UserDeny: userDeny}
		got := EffectiveChannelPerms(base, o)

		// The function must be exactly the two-layer composition its doc
		// comment describes: role layer over base, user layer over that.
		roleLayer := EffectivePerms(base, allow, deny)
		want := EffectivePerms(roleLayer, userAllow, userDeny)
		if got != want {
			t.Fatalf("EffectiveChannelPerms(%#x, %+v) = %#x, want %#x (= EffectivePerms(EffectivePerms(base,Allow,Deny),UserAllow,UserDeny))", base, o, got, want)
		}

		for bit := range 64 {
			mask := int64(1) << uint(bit)
			gotBit := got&mask != 0
			userAllowBit := userAllow&mask != 0
			userDenyBit := userDeny&mask != 0
			roleBit := roleLayer&mask != 0

			switch {
			case userAllowBit:
				// A user allow beats a user deny on the same bit, and beats
				// whatever the role layer decided.
				if !gotBit {
					t.Fatalf("EffectiveChannelPerms(%#x,%+v): bit %d in UserAllow but clear in result %#x", base, o, bit, got)
				}
			case userDenyBit:
				// A user deny (without a user allow) beats a role-layer
				// allow: the narrower, later layer always wins.
				if gotBit {
					t.Fatalf("EffectiveChannelPerms(%#x,%+v): bit %d in UserDeny (not UserAllow) but set in result %#x", base, o, bit, got)
				}
			default:
				// No user-layer opinion: the role layer's bit passes through.
				if gotBit != roleBit {
					t.Fatalf("EffectiveChannelPerms(%#x,%+v): bit %d untouched by user layer, want %v (role layer) got %v in result %#x", base, o, bit, roleBit, gotBit, got)
				}
			}
		}

		// A channel override that touches nothing must be a pure pass-through
		// of the base role permissions.
		if noop := EffectiveChannelPerms(base, ChannelOverride{}); noop != base {
			t.Fatalf("EffectiveChannelPerms(%#x, zero override) = %#x, want %#x unchanged", base, noop, base)
		}
	})
}
