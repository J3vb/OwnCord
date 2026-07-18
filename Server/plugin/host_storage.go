// Phase C Step 9 — `storage` host capability.
//
// Plugins get a per-plugin namespaced KV store backed by the PluginStore
// rows in the events/plugin schema. Capacity caps and value-size caps are
// enforced here so a misbehaving plugin can't fill the database.

package plugin

import (
	"context"
	"fmt"
)

const (
	maxPluginValueBytes = 64 * 1024  // 64 KB per value
	maxPluginScanLimit  = 1000       // hard cap on PluginKVScan results
)

// StoragePut writes a single key/value pair on behalf of inst.
func (r *Registry) StoragePut(ctx context.Context, inst *Instance, key string, value []byte) error {
	if !inst.Manifest.HasCapability(CapStorage) {
		return ErrCapabilityNotGranted
	}
	if len(value) > maxPluginValueBytes {
		return fmt.Errorf("plugin storage: value exceeds %d bytes", maxPluginValueBytes)
	}
	return r.cfg.Store.PluginKVSet(ctx, inst.ID, key, value)
}

// StorageGet returns the value for key, or (nil, error) when missing.
func (r *Registry) StorageGet(ctx context.Context, inst *Instance, key string) ([]byte, error) {
	if !inst.Manifest.HasCapability(CapStorage) {
		return nil, ErrCapabilityNotGranted
	}
	return r.cfg.Store.PluginKVGet(ctx, inst.ID, key)
}

// StorageDelete removes a key.
func (r *Registry) StorageDelete(ctx context.Context, inst *Instance, key string) error {
	if !inst.Manifest.HasCapability(CapStorage) {
		return ErrCapabilityNotGranted
	}
	return r.cfg.Store.PluginKVDelete(ctx, inst.ID, key)
}

// StorageScan returns all keys with the given prefix, capped at maxPluginScanLimit.
func (r *Registry) StorageScan(ctx context.Context, inst *Instance, prefix string, limit int) (map[string][]byte, error) {
	if !inst.Manifest.HasCapability(CapStorage) {
		return nil, ErrCapabilityNotGranted
	}
	if limit <= 0 || limit > maxPluginScanLimit {
		limit = maxPluginScanLimit
	}
	return r.cfg.Store.PluginKVScan(ctx, inst.ID, prefix, limit)
}
