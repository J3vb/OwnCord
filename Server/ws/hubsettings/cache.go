// Package hubsettings is the hub's cache of the settings auth_ok and ready carry
// (server_name, motd and the upload file-type lists), refreshed at most once per TTL.
package hubsettings

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws/lockrank"
)

// TTL is how long a refresh serves before the next read refreshes again.
const TTL = 30 * time.Second

// Reader is the hub's view of the settings family: one keyed read, defined consumer-side.
type Reader interface {
	Setting(ctx context.Context, key string) (string, error)
}

// FileTypes reads the upload file-type policy in force; service.UploadService satisfies it.
type FileTypes interface {
	FileTypePolicy(ctx context.Context) (storage.FileTypePolicy, error)
}

// UploadPolicy is what a client needs to refuse a doomed upload before sending it; the upload route stays
// authoritative.
type UploadPolicy struct {
	MaxUploadBytes int64 `json:"max_upload_bytes"`
	// BlockedExtensions and AllowedExtensions are the storage.FileTypePolicy in force: a
	// blocked final extension is refused; a non-empty allowed list is allow-only mode.
	BlockedExtensions []string `json:"blocked_extensions,omitempty"`
	AllowedExtensions []string `json:"allowed_extensions,omitempty"`
	// Thumbnails reports that GET /api/v1/files/{id}/thumb exists.
	Thumbnails bool `json:"thumbnails,omitempty"`
	// StagedLifetimeSeconds is how long an upload no message names is kept; a composer re-uploads a file held
	// longer.
	StagedLifetimeSeconds int64 `json:"staged_lifetime_seconds,omitempty"`
}

// Cache holds the cached values under one ranked lock (ws/lock_order.go). Must not be copied after first use.
type Cache struct {
	reader    Reader
	fileTypes FileTypes // may be nil: no file-type lists to refresh

	// mu is held for writing across the refresh's settings reads; see the exceptions in ws/lock_order.go.
	mu         syncutil.RankedRW[lockrank.HubCache]
	name       string
	motd       string
	upload     UploadPolicy // auth_ok's upload_policy; the lists refresh with the cache
	lastUpdate time.Time
}

// New returns a cache not yet read; its first Get refreshes it. upload is the startup part
// of the policy (size limit, thumbnails); every refresh replaces its lists. fileTypes may be nil.
func New(reader Reader, fileTypes FileTypes, upload UploadPolicy) Cache {
	return Cache{reader: reader, fileTypes: fileTypes, upload: upload, name: "OwnCord Server", motd: "Welcome!"}
}

// Reader is the settings seam the cache reads through.
func (c *Cache) Reader() Reader { return c.reader }

// FileTypes is the upload file-type seam, or nil.
func (c *Cache) FileTypes() FileTypes { return c.fileTypes }

// Get returns server_name and motd, refreshing the cache if stale.
func (c *Cache) Get(ctx context.Context) (name, motd string) {
	c.mu.RLock()
	if time.Since(c.lastUpdate) < TTL {
		name, motd = c.name, c.motd
		c.mu.RUnlock()
		return name, motd
	}
	c.mu.RUnlock()

	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.lastUpdate) < TTL {
		return c.name, c.motd
	}
	c.refreshLocked(ctx)
	return c.name, c.motd
}

// Refresh reloads the cache now, whatever its age.
func (c *Cache) Refresh(ctx context.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshLocked(ctx)
}

// refreshLocked reloads the cached settings. Caller holds mu for writing.
func (c *Cache) refreshLocked(ctx context.Context) {
	// The refresh serves the hub-wide cache, not the connection that triggered it: a dying
	// connection's ctx must not fail the fetches, or the TTL stamp would pin stale values for 30s.
	ctx = context.WithoutCancel(ctx)
	if name, err := c.reader.Setting(ctx, "server_name"); err == nil {
		c.name = name
	}
	if motd, err := c.reader.Setting(ctx, "motd"); err == nil {
		c.motd = motd
	}
	if c.fileTypes != nil {
		if p, err := c.fileTypes.FileTypePolicy(ctx); err == nil {
			c.upload.BlockedExtensions, c.upload.AllowedExtensions = p.Blocked, p.Allowed
		} else {
			slog.Warn("auth_ok: reading the upload file-type policy failed", "error", err)
		}
	}
	c.lastUpdate = time.Now()
}

// UploadPolicy returns auth_ok's upload_policy, refreshed with the cache when stale.
func (c *Cache) UploadPolicy(ctx context.Context) UploadPolicy {
	c.Get(ctx)
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.upload
}

// SetUploadLists stores freshly read file-type lists without waiting for the TTL.
func (c *Cache) SetUploadLists(blocked, allowed []string) {
	c.mu.Lock()
	c.upload.BlockedExtensions, c.upload.AllowedExtensions = blocked, allowed
	c.mu.Unlock()
}

// Expire makes the cache stale, so the next Get refreshes it.
func (c *Cache) Expire() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastUpdate = time.Time{}
}
