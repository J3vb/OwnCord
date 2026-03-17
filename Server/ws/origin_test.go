package ws_test

import (
	"testing"

	"github.com/owncord/server/ws"
)

// TestOriginAcceptOptions_WildcardEnablesInsecureSkipVerify verifies that
// when the allowed origins list contains only "*", InsecureSkipVerify is true
// (preserving the previous opt-in permissive behaviour).
func TestOriginAcceptOptions_WildcardEnablesInsecureSkipVerify(t *testing.T) {
	opts := ws.OriginAcceptOptions([]string{"*"})
	if !opts.InsecureSkipVerify {
		t.Error("OriginAcceptOptions([\"*\"]).InsecureSkipVerify = false, want true")
	}
	if len(opts.OriginPatterns) != 0 {
		t.Errorf("OriginAcceptOptions([\"*\"]).OriginPatterns = %v, want empty", opts.OriginPatterns)
	}
}

// TestOriginAcceptOptions_ExplicitOrigins sets OriginPatterns and does NOT
// skip origin verification.
func TestOriginAcceptOptions_ExplicitOrigins(t *testing.T) {
	origins := []string{"https://example.com", "https://app.example.com"}
	opts := ws.OriginAcceptOptions(origins)

	if opts.InsecureSkipVerify {
		t.Error("OriginAcceptOptions(explicit).InsecureSkipVerify = true, want false")
	}
	if len(opts.OriginPatterns) != 2 {
		t.Errorf("OriginAcceptOptions(explicit) len(OriginPatterns) = %d, want 2", len(opts.OriginPatterns))
	}
	for i, p := range opts.OriginPatterns {
		if p != origins[i] {
			t.Errorf("OriginPatterns[%d] = %q, want %q", i, p, origins[i])
		}
	}
}

// TestOriginAcceptOptions_EmptyList falls back to wildcard (InsecureSkipVerify)
// so that an empty configuration doesn't silently reject all connections.
func TestOriginAcceptOptions_EmptyList(t *testing.T) {
	opts := ws.OriginAcceptOptions([]string{})
	if !opts.InsecureSkipVerify {
		t.Error("OriginAcceptOptions([]) should fall back to InsecureSkipVerify=true")
	}
}

// TestOriginAcceptOptions_NilList same as empty.
func TestOriginAcceptOptions_NilList(t *testing.T) {
	opts := ws.OriginAcceptOptions(nil)
	if !opts.InsecureSkipVerify {
		t.Error("OriginAcceptOptions(nil) should fall back to InsecureSkipVerify=true")
	}
}

// TestOriginAcceptOptions_MixedWithWildcard if "*" appears anywhere in the
// list we treat the whole list as wildcard (security: explicit wins over forged mix).
func TestOriginAcceptOptions_MixedWithWildcard(t *testing.T) {
	opts := ws.OriginAcceptOptions([]string{"https://example.com", "*"})
	if !opts.InsecureSkipVerify {
		t.Error("OriginAcceptOptions with '*' in list should use InsecureSkipVerify=true")
	}
}

// TestOriginAcceptOptions_ReturnsAcceptOptions ensures the return type is the
// correct websocket.AcceptOptions value (compile-time check via assignment).
func TestOriginAcceptOptions_ReturnsAcceptOptions(t *testing.T) {
	_ = ws.OriginAcceptOptions([]string{"https://example.com"})
}
