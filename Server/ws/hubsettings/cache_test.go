package hubsettings_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/ws/hubsettings"
)

type fakeReader struct {
	reads atomic.Int32
	vals  map[string]string
}

func (r *fakeReader) Setting(ctx context.Context, key string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	r.reads.Add(1)
	v, ok := r.vals[key]
	if !ok {
		return "", errors.New("missing")
	}
	return v, nil
}

type fakeFileTypes struct {
	p   storage.FileTypePolicy
	err error
}

func (f fakeFileTypes) FileTypePolicy(context.Context) (storage.FileTypePolicy, error) {
	return f.p, f.err
}

func TestCache_ZeroValueLocksWork(t *testing.T) {
	var c hubsettings.Cache
	c.Expire()
	c.SetUploadLists([]string{"exe"}, nil)
	if c.FileTypes() != nil || c.Reader() != nil {
		t.Fatal("a zero cache has no seams")
	}
}

func TestCache_GetRefreshesOncePerTTL(t *testing.T) {
	r := &fakeReader{vals: map[string]string{"server_name": "Home", "motd": "hi"}}
	c := hubsettings.New(r, nil, hubsettings.UploadPolicy{MaxUploadBytes: 10})

	name, motd := c.Get(context.Background())
	if name != "Home" || motd != "hi" {
		t.Fatalf("Get = %q, %q", name, motd)
	}
	c.Get(context.Background())
	if n := r.reads.Load(); n != 2 {
		t.Fatalf("reads = %d after two Gets within the TTL, want 2 (one refresh)", n)
	}
	c.Expire()
	c.Get(context.Background())
	if n := r.reads.Load(); n != 4 {
		t.Fatalf("reads = %d after Expire, want 4", n)
	}
}

func TestCache_RefreshIgnoresCallerCancellation(t *testing.T) {
	r := &fakeReader{vals: map[string]string{"server_name": "Home", "motd": "hi"}}
	c := hubsettings.New(r, nil, hubsettings.UploadPolicy{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if name, _ := c.Get(ctx); name != "Home" {
		t.Fatalf("a cancelled caller left the default name %q", name)
	}
}

func TestCache_UploadPolicyKeepsStartupFieldsAndRefreshesLists(t *testing.T) {
	r := &fakeReader{vals: map[string]string{}}
	ft := fakeFileTypes{p: storage.FileTypePolicy{Blocked: []string{"exe"}, Allowed: []string{"png"}}}
	c := hubsettings.New(r, ft, hubsettings.UploadPolicy{MaxUploadBytes: 10, Thumbnails: true})

	got := c.UploadPolicy(context.Background())
	if got.MaxUploadBytes != 10 || !got.Thumbnails || len(got.BlockedExtensions) != 1 || len(got.AllowedExtensions) != 1 {
		t.Fatalf("UploadPolicy = %+v", got)
	}
	if name, motd := c.Get(context.Background()); name != "OwnCord Server" || motd != "Welcome!" {
		t.Fatalf("failed reads should keep the defaults, got %q, %q", name, motd)
	}

	c.SetUploadLists(nil, []string{"jpg"})
	got = c.UploadPolicy(context.Background())
	if len(got.BlockedExtensions) != 0 || len(got.AllowedExtensions) != 1 || got.AllowedExtensions[0] != "jpg" {
		t.Fatalf("SetUploadLists not visible: %+v", got)
	}
}

func TestCache_FailedFileTypeReadKeepsLists(t *testing.T) {
	r := &fakeReader{vals: map[string]string{}}
	c := hubsettings.New(r, fakeFileTypes{err: errors.New("down")}, hubsettings.UploadPolicy{BlockedExtensions: []string{"exe"}})
	if got := c.UploadPolicy(context.Background()); len(got.BlockedExtensions) != 1 {
		t.Fatalf("a failed read dropped the lists: %+v", got)
	}
}
