package admin_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/db"
)

// ─── Channel-type validation (via POST /channels) ───────────────────────────
//
// Categories used to constrain the type: a voice channel could only be created
// under a category literally named "Voice Channels". That rule is gone —
// categories are free text and grouping is a display concern — so the tests
// below assert the inverse: EVERY type is creatable under ANY category, and the
// only thing a create request can get wrong is the type itself.

func newChannelTestAPI(t *testing.T) (http.Handler, string, *db.DB) {
	t.Helper()
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	return handler, createAdminUser(t, database), database
}

func TestCreateChannel_AnyTypeUnderAnyCategory(t *testing.T) {
	cases := []struct {
		name     string
		chType   string
		category string
	}{
		{"text under a text-sounding category", "text", "Chat"},
		{"announcement under a text-sounding category", "announcement", "Text Channels"},
		{"voice under the legacy voice category", "voice", "Voice Channels"},
		{"voice under an arbitrary category", "voice", "Gaming"},
		{"text under the legacy voice category", "text", "Voice Channels"},
		{"text under an uppercase voice-sounding category", "text", "VOICE CHANNELS"},
		{"voice with no category at all", "voice", ""},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler, token, _ := newChannelTestAPI(t)
			body := map[string]any{
				"name":     "ch" + string(rune('a'+i)),
				"type":     tc.chType,
				"category": tc.category,
			}
			w := doRequest(t, handler, http.MethodPost, "/channels", token, body)
			if w.Code != http.StatusCreated {
				t.Errorf("status = %d, want 201; body: %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestCreateChannel_UnknownTypeRejected(t *testing.T) {
	handler, token, _ := newChannelTestAPI(t)

	body := map[string]any{
		"name":     "weird",
		"type":     "forum",
		"category": "Chat",
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err == nil {
		if resp["error"] != "INVALID_INPUT" {
			t.Errorf("error code = %q, want INVALID_INPUT", resp["error"])
		}
	}
}

// PATCH now accepts category, so a channel can be moved between categories
// without being recreated. An omitted category must keep the existing one —
// the handler seeds the request struct from the current row.
func TestPatchChannel_MovesCategory(t *testing.T) {
	handler, token, _ := newChannelTestAPI(t)

	create := doRequest(t, handler, http.MethodPost, "/channels", token, map[string]any{
		"name": "lounge", "type": "voice", "category": "Gaming",
	})
	if create.Code != http.StatusCreated {
		t.Fatalf("create: status = %d; body: %s", create.Code, create.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal created: %v", err)
	}

	path := fmt.Sprintf("/channels/%d", created.ID)
	moved := doRequest(t, handler, http.MethodPatch, path, token, map[string]any{
		"name": "lounge", "category": "Hangout",
	})
	if moved.Code != http.StatusOK {
		t.Fatalf("patch: status = %d; body: %s", moved.Code, moved.Body.String())
	}
	var afterMove struct {
		Category string `json:"category"`
	}
	if err := json.Unmarshal(moved.Body.Bytes(), &afterMove); err != nil {
		t.Fatalf("unmarshal moved: %v", err)
	}
	if afterMove.Category != "Hangout" {
		t.Errorf("category = %q, want Hangout", afterMove.Category)
	}

	// A body without "category" must not blank it out.
	kept := doRequest(t, handler, http.MethodPatch, path, token, map[string]any{
		"name": "lounge-2",
	})
	if kept.Code != http.StatusOK {
		t.Fatalf("patch without category: status = %d; body: %s", kept.Code, kept.Body.String())
	}
	var afterKeep struct {
		Category string `json:"category"`
	}
	if err := json.Unmarshal(kept.Body.Bytes(), &afterKeep); err != nil {
		t.Fatalf("unmarshal kept: %v", err)
	}
	if afterKeep.Category != "Hangout" {
		t.Errorf("category after omitted patch = %q, want Hangout", afterKeep.Category)
	}
}

// ─── Channel feature flags: nsfw + voice capacity limits ─────────────────────
//
// The three fields ride on the same PATCH as name/topic/category, so the tests
// below cover the three things that can go wrong with a field bolted onto a
// partial-body handler: it must round-trip, an omitted field must not clobber
// the stored value, and an out-of-range value must be refused rather than
// stored.

// newChannel creates a channel through the API and returns its id.
func newChannel(t *testing.T, handler http.Handler, token, name, chType string) int64 {
	t.Helper()
	w := doRequest(t, handler, http.MethodPost, "/channels", token, map[string]any{
		"name": name, "type": chType,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create %s: status = %d; body: %s", name, w.Code, w.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal created: %v", err)
	}
	return created.ID
}

// channelFlags is the slice of the channel JSON these tests assert on.
type channelFlags struct {
	NSFW          bool `json:"nsfw"`
	SlowMode      int  `json:"slow_mode"`
	VoiceMaxUsers int  `json:"voice_max_users"`
	VoiceMaxVideo int  `json:"voice_max_video"`
}

func patchChannelFlags(t *testing.T, handler http.Handler, token string, id int64, body map[string]any) channelFlags {
	t.Helper()
	w := doRequest(t, handler, http.MethodPatch, fmt.Sprintf("/channels/%d", id), token, body)
	if w.Code != http.StatusOK {
		t.Fatalf("patch: status = %d; body: %s", w.Code, w.Body.String())
	}
	var got channelFlags
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal patched: %v", err)
	}
	return got
}

func TestPatchChannel_SetsFeatureFlags(t *testing.T) {
	handler, token, _ := newChannelTestAPI(t)
	id := newChannel(t, handler, token, "lounge", "voice")

	got := patchChannelFlags(t, handler, token, id, map[string]any{
		"nsfw":            true,
		"slow_mode":       30,
		"voice_max_users": 5,
		"voice_max_video": 2,
	})
	want := channelFlags{NSFW: true, SlowMode: 30, VoiceMaxUsers: 5, VoiceMaxVideo: 2}
	if got != want {
		t.Errorf("flags after patch = %+v, want %+v", got, want)
	}
}

// An omitted field keeps its stored value — the handler seeds the request
// struct from the current row, which is the only thing that makes a partial
// PATCH body (the one every client sends) non-destructive.
func TestPatchChannel_OmittedFlagsPreserved(t *testing.T) {
	handler, token, _ := newChannelTestAPI(t)
	id := newChannel(t, handler, token, "lounge", "voice")

	patchChannelFlags(t, handler, token, id, map[string]any{
		"nsfw": true, "slow_mode": 15, "voice_max_users": 8, "voice_max_video": 3,
	})

	// A rename touches nothing else.
	got := patchChannelFlags(t, handler, token, id, map[string]any{"name": "lounge-2"})
	want := channelFlags{NSFW: true, SlowMode: 15, VoiceMaxUsers: 8, VoiceMaxVideo: 3}
	if got != want {
		t.Errorf("flags after rename = %+v, want %+v (unchanged)", got, want)
	}
}

func TestPatchChannel_ClearsNSFW(t *testing.T) {
	handler, token, _ := newChannelTestAPI(t)
	id := newChannel(t, handler, token, "spicy", "text")

	patchChannelFlags(t, handler, token, id, map[string]any{"nsfw": true})
	if got := patchChannelFlags(t, handler, token, id, map[string]any{"nsfw": false}); got.NSFW {
		t.Error("nsfw = true after clearing, want false")
	}
}

func TestPatchChannel_RejectsOutOfRangeValues(t *testing.T) {
	cases := []struct {
		name string
		body map[string]any
	}{
		{"slow mode above the 6-hour ceiling", map[string]any{"slow_mode": 21601}},
		{"negative slow mode", map[string]any{"slow_mode": -1}},
		{"user limit above 99", map[string]any{"voice_max_users": 100}},
		{"negative user limit", map[string]any{"voice_max_users": -1}},
		{"video limit above 99", map[string]any{"voice_max_video": 100}},
		{"negative video limit", map[string]any{"voice_max_video": -5}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler, token, _ := newChannelTestAPI(t)
			id := newChannel(t, handler, token, "lounge", "voice")

			w := doRequest(t, handler, http.MethodPatch, fmt.Sprintf("/channels/%d", id), token, tc.body)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
			}
			var resp map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("unmarshal error body: %v", err)
			}
			if resp["error"] != "INVALID_INPUT" {
				t.Errorf("error code = %q, want INVALID_INPUT", resp["error"])
			}
		})
	}
}

// The boundary values themselves are legal — an off-by-one in validate() that
// refused 21600 or 99 would silently cap what the clients offer.
func TestPatchChannel_AcceptsBoundaryValues(t *testing.T) {
	handler, token, _ := newChannelTestAPI(t)
	id := newChannel(t, handler, token, "lounge", "voice")

	got := patchChannelFlags(t, handler, token, id, map[string]any{
		"slow_mode": 21600, "voice_max_users": 99, "voice_max_video": 99,
	})
	want := channelFlags{SlowMode: 21600, VoiceMaxUsers: 99, VoiceMaxVideo: 99}
	if got != want {
		t.Errorf("flags = %+v, want %+v", got, want)
	}
}

// A refused patch must not have written anything — validation runs before the
// update, so a rejected body cannot half-apply the fields that were in range.
func TestPatchChannel_RejectedPatchWritesNothing(t *testing.T) {
	handler, token, _ := newChannelTestAPI(t)
	id := newChannel(t, handler, token, "lounge", "voice")

	w := doRequest(t, handler, http.MethodPatch, fmt.Sprintf("/channels/%d", id), token, map[string]any{
		"name": "renamed", "nsfw": true, "voice_max_users": 500,
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}

	list := doRequest(t, handler, http.MethodGet, "/channels", token, nil)
	var channels []struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
		NSFW bool   `json:"nsfw"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &channels); err != nil {
		t.Fatalf("unmarshal channels: %v", err)
	}
	for _, ch := range channels {
		if ch.ID != id {
			continue
		}
		if ch.Name != "lounge" || ch.NSFW {
			t.Errorf("channel after refused patch = {name:%q nsfw:%v}, want {lounge false}", ch.Name, ch.NSFW)
		}
		return
	}
	t.Fatalf("channel %d missing from the list", id)
}

// The broadcast must carry the new fields, not just the stored row: the
// desktop client updates its channel store from channel_update alone and would
// otherwise show a stale gate until the next reconnect.
func TestPatchChannel_BroadcastCarriesFeatureFlags(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	id := newChannel(t, handler, token, "lounge", "voice")
	patchChannelFlags(t, handler, token, id, map[string]any{
		"nsfw": true, "voice_max_users": 4, "voice_max_video": 1,
	})

	if len(hub.channelUpdates) == 0 {
		t.Fatal("no channel_update broadcast")
	}
	got := hub.channelUpdates[len(hub.channelUpdates)-1]
	if !got.NSFW {
		t.Error("broadcast NSFW = false, want true")
	}
	if got.VoiceMaxUsers != 4 || got.VoiceMaxVideo != 1 {
		t.Errorf("broadcast voice limits = %d/%d, want 4/1", got.VoiceMaxUsers, got.VoiceMaxVideo)
	}
}

// Flipping the flag is the one part of a channel edit an operator may need to
// answer for later, so the audit detail names the transition.
func TestPatchChannel_AuditsNSFWTransition(t *testing.T) {
	handler, token, database := newChannelTestAPI(t)
	id := newChannel(t, handler, token, "spicy", "text")

	patchChannelFlags(t, handler, token, id, map[string]any{"nsfw": true})
	patchChannelFlags(t, handler, token, id, map[string]any{"nsfw": false})
	// A patch that leaves the flag alone must not claim a transition.
	patchChannelFlags(t, handler, token, id, map[string]any{"name": "spicy-2"})

	entries, err := database.GetAuditLog(t.Context(), 50, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	var marked, unmarked, plain int
	for _, e := range entries {
		if e.Action != "channel_update" {
			continue
		}
		switch {
		case strings.Contains(e.Detail, "(marked NSFW)"):
			marked++
		case strings.Contains(e.Detail, "(unmarked NSFW)"):
			unmarked++
		default:
			plain++
		}
	}
	if marked != 1 || unmarked != 1 || plain != 1 {
		t.Errorf("audit details: marked=%d unmarked=%d plain=%d, want 1/1/1", marked, unmarked, plain)
	}
}

// MANAGE_CHANNELS gates the whole channel surface; a member without it cannot
// set the flags either. The desktop client hides the controls on the same bit,
// but the server is the authority.
func TestPatchChannel_FeatureFlagsRequireManageChannels(t *testing.T) {
	handler, adminToken, database := newChannelTestAPI(t)
	id := newChannel(t, handler, adminToken, "lounge", "voice")

	memberToken := createMemberUser(t, database)
	w := doRequest(t, handler, http.MethodPatch, fmt.Sprintf("/channels/%d", id), memberToken, map[string]any{
		"nsfw": true,
	})
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403; body: %s", w.Code, w.Body.String())
	}
}

// ─── DM exclusion (A-2026-08-02) ─────────────────────────────────────────────
//
// DMs and group DMs share the channels table and id space with guild channels,
// but they belong to their participants. The admin channel surface must not
// enumerate them (membership-graph oracle), rename them, or cascade-delete
// them. Mutations answer 404 rather than 403 so the surface does not confirm
// which ids are private conversations.

func TestListChannels_ExcludesDMs(t *testing.T) {
	handler, token, database := newChannelTestAPI(t)

	textID := newChannel(t, handler, token, "general", "text")
	dmID, err := database.CreateChannel(context.Background(), "dm-chan", "dm", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel dm: %v", err)
	}

	w := doRequest(t, handler, http.MethodGet, "/channels", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var channels []struct {
		ID   int64  `json:"id"`
		Type string `json:"type"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &channels); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	sawText := false
	for _, ch := range channels {
		if ch.ID == dmID || ch.Type == "dm" {
			t.Errorf("DM channel %d leaked into admin channel list", ch.ID)
		}
		if ch.ID == textID {
			sawText = true
		}
	}
	if !sawText {
		t.Errorf("guild channel %d missing from admin channel list", textID)
	}
}

func TestPatchChannel_RefusesDM(t *testing.T) {
	handler, token, database := newChannelTestAPI(t)

	dmID, err := database.CreateChannel(context.Background(), "dm-chan", "dm", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel dm: %v", err)
	}

	w := doRequest(t, handler, http.MethodPatch, fmt.Sprintf("/channels/%d", dmID), token, map[string]any{
		"name": "renamed-by-admin",
	})
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body: %s", w.Code, w.Body.String())
	}

	ch, err := database.GetChannel(context.Background(), dmID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel after refused patch: ch=%v err=%v", ch, err)
	}
	if ch.Name != "dm-chan" {
		t.Errorf("DM renamed by refused patch: %q", ch.Name)
	}
}

func TestDeleteChannel_RefusesDM(t *testing.T) {
	handler, token, database := newChannelTestAPI(t)

	dmID, err := database.CreateChannel(context.Background(), "dm-chan", "dm", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel dm: %v", err)
	}

	w := doRequest(t, handler, http.MethodDelete, fmt.Sprintf("/channels/%d", dmID), token, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body: %s", w.Code, w.Body.String())
	}

	ch, err := database.GetChannel(context.Background(), dmID)
	if err != nil {
		t.Fatalf("GetChannel after refused delete: %v", err)
	}
	if ch == nil {
		t.Error("DM channel destroyed by refused delete")
	}
}
