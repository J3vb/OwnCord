// `storage` host capability: a per-plugin KV store with capacity and value-size
// caps so a plugin cannot fill the database.

package plugin

import (
	"context"
	"fmt"
)

// Key isolation is structural: every call passes inst.ID as the namespace and
// no parameter lets a caller name another plugin's, matching the plugin_kv
// PRIMARY KEY (plugin_id, key).
const (
	maxPluginKeyBytes   = 256       // 256 B per key
	maxPluginValueBytes = 64 * 1024 // 64 KB per value
	maxPluginScanLimit  = 1000      // hard cap on PluginKVScan results
)

// StoragePut writes a single key/value pair on behalf of inst.
func (r *Registry) StoragePut(ctx context.Context, inst *Instance, key string, value []byte) error {
	if !inst.Manifest.HasCapability(CapStorage) {
		return ErrCapabilityNotGranted
	}
	if key == "" {
		return fmt.Errorf("plugin storage: key must not be empty")
	}
	if len(key) > maxPluginKeyBytes {
		return fmt.Errorf("plugin storage: key exceeds %d bytes", maxPluginKeyBytes)
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
