package store

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/owncord/server/db"
)

// memEventStore is an in-memory EventStore + PluginStore implementation
// embedded into MemStore via the field below.
type memEventStore struct {
	mu       sync.Mutex
	nextSeq  atomic.Int64
	events   []db.PersistedEvent
	plugins  map[int64]*db.PluginRow
	nextPID  int64
	pluginKV map[int64]map[string][]byte
}

func newMemEventStore() *memEventStore {
	return &memEventStore{
		plugins:  make(map[int64]*db.PluginRow),
		pluginKV: make(map[int64]map[string][]byte),
	}
}

// ---------- EventStore ----------

func (m *MemStore) ensureEvents() *memEventStore {
	m.eventsOnce.Do(func() {
		m.eventStore = newMemEventStore()
	})
	return m.eventStore
}

func (m *MemStore) PersistEvent(_ context.Context, eventType string, channelID int64, payload []byte) (int64, error) {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	seq := es.nextSeq.Add(1)
	cp := make([]byte, len(payload))
	copy(cp, payload)
	es.events = append(es.events, db.PersistedEvent{
		Seq:       seq,
		EventType: eventType,
		ChannelID: channelID,
		Payload:   cp,
		CreatedAt: time.Now().UTC(),
	})
	return seq, nil
}

func (m *MemStore) GetEventsSince(_ context.Context, afterSeq int64, limit int) ([]db.PersistedEvent, error) {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	out := make([]db.PersistedEvent, 0)
	for _, e := range es.events {
		if e.Seq > afterSeq {
			out = append(out, e)
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

func (m *MemStore) GetEventsSinceForChannels(_ context.Context, afterSeq int64, channelIDs []int64, limit int) ([]db.PersistedEvent, error) {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	allowed := make(map[int64]bool, len(channelIDs))
	for _, cid := range channelIDs {
		allowed[cid] = true
	}
	out := make([]db.PersistedEvent, 0)
	for _, e := range es.events {
		if e.Seq <= afterSeq {
			continue
		}
		if e.ChannelID == 0 || allowed[e.ChannelID] {
			out = append(out, e)
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

func (m *MemStore) PruneEventsOlderThan(_ context.Context, cutoff time.Time) (int64, error) {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	kept := es.events[:0]
	var deleted int64
	for _, e := range es.events {
		if e.CreatedAt.Before(cutoff) {
			deleted++
			continue
		}
		kept = append(kept, e)
	}
	es.events = kept
	return deleted, nil
}

// ---------- PluginStore ----------

func (m *MemStore) InstallPlugin(_ context.Context, name, version, manifestJSON string) (int64, error) {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	for _, p := range es.plugins {
		if p.Name == name {
			p.Version = version
			p.ManifestJSON = manifestJSON
			return p.ID, nil
		}
	}
	es.nextPID++
	id := es.nextPID
	es.plugins[id] = &db.PluginRow{
		ID:           id,
		Name:         name,
		Version:      version,
		Enabled:      false,
		ManifestJSON: manifestJSON,
		InstalledAt:  time.Now().UTC(),
	}
	return id, nil
}

func (m *MemStore) EnablePlugin(_ context.Context, id int64) error {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	p, ok := es.plugins[id]
	if !ok {
		return fmt.Errorf("plugin %d not found", id)
	}
	p.Enabled = true
	return nil
}

func (m *MemStore) DisablePlugin(_ context.Context, id int64) error {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	p, ok := es.plugins[id]
	if !ok {
		return fmt.Errorf("plugin %d not found", id)
	}
	p.Enabled = false
	return nil
}

func (m *MemStore) UninstallPlugin(_ context.Context, id int64) error {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	delete(es.plugins, id)
	delete(es.pluginKV, id)
	return nil
}

func (m *MemStore) GetPlugin(_ context.Context, id int64) (*db.PluginRow, error) {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	p, ok := es.plugins[id]
	if !ok {
		return nil, fmt.Errorf("plugin %d not found", id)
	}
	cp := *p
	return &cp, nil
}

func (m *MemStore) GetPluginByName(_ context.Context, name string) (*db.PluginRow, error) {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	for _, p := range es.plugins {
		if p.Name == name {
			cp := *p
			return &cp, nil
		}
	}
	return nil, fmt.Errorf("plugin %q not found", name)
}

func (m *MemStore) ListPlugins(_ context.Context) ([]db.PluginRow, error) {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	out := make([]db.PluginRow, 0, len(es.plugins))
	for _, p := range es.plugins {
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (m *MemStore) PluginKVGet(_ context.Context, pluginID int64, key string) ([]byte, error) {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	bucket, ok := es.pluginKV[pluginID]
	if !ok {
		return nil, fmt.Errorf("kv: plugin %d not found", pluginID)
	}
	v, ok := bucket[key]
	if !ok {
		return nil, fmt.Errorf("kv: key %q not found", key)
	}
	cp := make([]byte, len(v))
	copy(cp, v)
	return cp, nil
}

func (m *MemStore) PluginKVSet(_ context.Context, pluginID int64, key string, value []byte) error {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	bucket, ok := es.pluginKV[pluginID]
	if !ok {
		bucket = make(map[string][]byte)
		es.pluginKV[pluginID] = bucket
	}
	cp := make([]byte, len(value))
	copy(cp, value)
	bucket[key] = cp
	return nil
}

func (m *MemStore) PluginKVDelete(_ context.Context, pluginID int64, key string) error {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	if bucket, ok := es.pluginKV[pluginID]; ok {
		delete(bucket, key)
	}
	return nil
}

func (m *MemStore) PluginKVScan(_ context.Context, pluginID int64, prefix string, limit int) (map[string][]byte, error) {
	es := m.ensureEvents()
	es.mu.Lock()
	defer es.mu.Unlock()
	out := make(map[string][]byte)
	bucket, ok := es.pluginKV[pluginID]
	if !ok {
		return out, nil
	}
	keys := make([]string, 0, len(bucket))
	for k := range bucket {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if limit > 0 && len(keys) > limit {
		keys = keys[:limit]
	}
	for _, k := range keys {
		v := bucket[k]
		cp := make([]byte, len(v))
		copy(cp, v)
		out[k] = cp
	}
	return out, nil
}
