package admin

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

const (
	supportTTL          = 5 * time.Minute
	supportMaxSnapshots = 16
	supportMaxBytes     = 256 << 10
)

type supportItem struct {
	Name        string `json:"name"`
	ByteSize    int    `json:"byte_size"`
	SHA256      string `json:"sha256"`
	DataClasses []int  `json:"data_classes"`
}

type supportRedaction struct {
	Item    string `json:"item"`
	Rule    string `json:"rule"`
	Omitted string `json:"omitted"`
}

type supportPreview struct {
	ID         string             `json:"preview_id"`
	ExpiresAt  time.Time          `json:"expires_at"`
	ByteSize   int                `json:"byte_size"`
	SHA256     string             `json:"sha256"`
	Items      []supportItem      `json:"items"`
	Redactions []supportRedaction `json:"redactions"`
}

type supportSnapshot struct {
	preview supportPreview
	bytes   []byte
	actor   int64
	session string
	expiry  *time.Timer
}

// Every router owns a bounded store. No background collector, persistence or
// network egress: data is collected only when an administrator clicks Preview.
type supportBundles struct {
	mu        syncutil.Mutex
	snapshots map[string]*supportSnapshot
	building  bool
	downloads chan struct{}
	now       func() time.Time
	service   *service.DiagnosticsService
	version   string
	config    *config.Config
	logs      *RingBuffer
	hub       HubBroadcaster
}

func newSupportBundles(svc *service.DiagnosticsService, version string, cfg *config.Config, logs *RingBuffer, hub HubBroadcaster) *supportBundles {
	return &supportBundles{snapshots: make(map[string]*supportSnapshot), downloads: make(chan struct{}, 2), now: time.Now, service: svc, version: version, config: cfg, logs: logs, hub: hub}
}

func (s *supportBundles) reserve() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, snapshot := range s.snapshots {
		if !s.now().Before(snapshot.preview.ExpiresAt) {
			if snapshot.expiry != nil {
				snapshot.expiry.Stop()
			}
			delete(s.snapshots, id)
		}
	}
	if s.building {
		return false
	}
	s.building = true
	return true
}

func (s *supportBundles) release() { s.mu.Lock(); s.building = false; s.mu.Unlock() }

func (s *supportBundles) save(snapshot supportSnapshot) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, previous := range s.snapshots {
		if previous.session == snapshot.session {
			if previous.expiry != nil {
				previous.expiry.Stop()
			}
			delete(s.snapshots, id)
		}
	}
	if len(s.snapshots) >= supportMaxSnapshots {
		return false
	}
	id := snapshot.preview.ID
	snapshot.expiry = time.AfterFunc(supportTTL, func() { s.mu.Lock(); delete(s.snapshots, id); s.mu.Unlock() })
	s.snapshots[snapshot.preview.ID] = &snapshot
	return true
}

func (s *supportBundles) take(id, hash, session string, actor int64) (supportSnapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.snapshots[id]
	if !ok || v.session != session || v.actor != actor || v.preview.SHA256 != hash {
		return supportSnapshot{}, false
	}
	delete(s.snapshots, id)
	if v.expiry != nil {
		v.expiry.Stop()
	}
	return *v, s.now().Before(v.preview.ExpiresAt)
}

func supportJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid support bundle request")
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "expected one JSON object")
		return false
	}
	return true
}

func (s *supportBundles) preview(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	session, ok := supportSession(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "FORBIDDEN", "sign in with an administrator account to preview diagnostics")
		return
	}
	if !supportJSON(w, r, &struct{}{}) {
		return
	}
	if !s.reserve() {
		writeErr(w, http.StatusTooManyRequests, "BUSY", "a diagnostic preview is being prepared; try again shortly")
		return
	}
	defer s.release()
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	snapshot, err := s.collect(ctx)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "UNAVAILABLE", "could not collect diagnostics within the time and size limits")
		return
	}
	snapshot.actor, snapshot.session = actorFromContext(r), session
	if !s.save(snapshot) {
		writeErr(w, http.StatusTooManyRequests, "BUSY", "diagnostic preview capacity reached; try again after five minutes")
		return
	}
	writeJSON(w, http.StatusOK, snapshot.preview)
}

func (s *supportBundles) download(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	session, ok := supportSession(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "FORBIDDEN", "sign in with an administrator account to download diagnostics")
		return
	}
	var req struct {
		ID     string `json:"preview_id"`
		SHA256 string `json:"sha256"`
	}
	if !supportJSON(w, r, &req) {
		return
	}
	// A slow reader must not retain unlimited consumed archives while new
	// previews refill the store. Bound in-flight downloads as well as storage.
	select {
	case s.downloads <- struct{}{}:
		defer func() { <-s.downloads }()
	default:
		writeErr(w, http.StatusTooManyRequests, "BUSY", "diagnostic downloads are busy; try again shortly")
		return
	}
	v, ok := s.take(req.ID, req.SHA256, session, actorFromContext(r))
	if !ok {
		writeErr(w, http.StatusGone, "PREVIEW_EXPIRED", "preview unavailable; create and review a new preview")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.service.RecordBundle(ctx, v.actor); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "UNAVAILABLE", "could not record the export; create a new preview")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="owncord-support.zip"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(v.bytes)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Content-SHA256", v.preview.SHA256)
	_, _ = w.Write(v.bytes)
}

func supportHash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func (s *supportBundles) collect(ctx context.Context) (supportSnapshot, error) {
	database, err := s.service.Snapshot(ctx)
	if err != nil {
		return supportSnapshot{}, err
	}
	created := s.now().UTC()
	data := []struct {
		name    string
		classes []int
		value   any
	}{
		{"build.json", []int{}, supportBuild(s.version)},
		{"configuration.json", []int{}, supportConfig(s.config)},
		{"database.json", []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21}, database},
		{"health.json", []int{}, supportHealth(s.hub, created)},
		{"events.json", []int{22}, supportEvents(s.logs)},
	}
	var buffer bytes.Buffer
	zw := zip.NewWriter(&buffer)
	items := make([]supportItem, 0, len(data)+1)
	for _, item := range data {
		entry, err := addSupportItem(zw, item.name, item.classes, item.value)
		if err != nil {
			return supportSnapshot{}, err
		}
		items = append(items, entry)
	}
	redactions := supportRedactions()
	manifest := struct {
		Format     int                `json:"format"`
		CapturedAt time.Time          `json:"captured_at"`
		Items      []supportItem      `json:"items"`
		Redactions []supportRedaction `json:"redactions"`
	}{1, created, items, redactions}
	entry, err := addSupportItem(zw, "manifest.json", []int{}, manifest)
	if err != nil {
		return supportSnapshot{}, err
	}
	items = append(items, entry)
	if err := zw.Close(); err != nil {
		return supportSnapshot{}, err
	}
	if buffer.Len() > supportMaxBytes {
		return supportSnapshot{}, fmt.Errorf("support bundle exceeds size limit")
	}
	id := make([]byte, 32)
	if _, err := rand.Read(id); err != nil {
		return supportSnapshot{}, err
	}
	return supportSnapshot{bytes: buffer.Bytes(), preview: supportPreview{ID: hex.EncodeToString(id), ExpiresAt: created.Add(supportTTL), ByteSize: buffer.Len(), SHA256: supportHash(buffer.Bytes()), Items: items, Redactions: redactions}}, nil
}

func addSupportItem(zw *zip.Writer, name string, classes []int, value any) (supportItem, error) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return supportItem{}, err
	}
	if len(data) > supportMaxBytes {
		return supportItem{}, fmt.Errorf("support item exceeds size limit")
	}
	f, err := zw.Create(name)
	if err != nil {
		return supportItem{}, err
	}
	if _, err := f.Write(data); err != nil {
		return supportItem{}, err
	}
	return supportItem{Name: name, ByteSize: len(data), SHA256: supportHash(data), DataClasses: classes}, nil
}
