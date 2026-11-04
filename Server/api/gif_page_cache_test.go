package api

import (
	"testing"
	"time"
)

func TestGIFPageCache_ExpiresAndStaysBounded(t *testing.T) {
	c := newGIFPageCache(time.Minute, 2)
	now := time.Unix(0, 0)
	c.now = func() time.Time { return now }
	c.put("a", gifResponse{Next: "a"})
	now = now.Add(time.Second)
	c.put("b", gifResponse{Next: "b"})
	now = now.Add(time.Second)
	c.put("c", gifResponse{Next: "c"}) // full: a is closest to expiring
	if _, ok := c.get("a"); ok {
		t.Error("a kept past the entry bound")
	}
	if p, ok := c.get("c"); !ok || p.Next != "c" {
		t.Errorf("c = %+v, %v", p, ok)
	}
	now = now.Add(time.Minute)
	if _, ok := c.get("c"); ok {
		t.Error("c outlived its TTL")
	}
	var none *gifPageCache
	none.put("x", gifResponse{})
	if _, ok := none.get("x"); ok {
		t.Error("a nil cache kept a page")
	}
}
