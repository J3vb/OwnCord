package ws_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── WP 7.3b: channel, chat and admin frames ─────────────────────────────────
//
// Most of these frames have no websocket command that produces them: the REST
// or service layer decides, and the hub only fans out. The journeys therefore
// trigger them the way production does where the harness can (the DM and NSFW
// routes are mounted over the rig's hub; the moderation and appeal services are
// wired to it as api/router.go wires them) and otherwise call the exported hub
// method the admin/service layer calls. Each journey says which.
//
// Targeted, unsequenced frames (mention_count, mod_queue, mod_action,
// appeal_status, presence) travel on the LOW-priority queue, which pong may
// overtake — so those journeys read the low frame BEFORE their barrier is
// sent, never after: nothing is pending on the low queue when ping goes out.

// restRig is the rig's REST surface: the DM and NSFW routes, authenticated by
// the same session tokens the websockets use, with the hub as broadcaster.
type restRig struct {
	url string
}

func (r *epochRig) mountREST(t *testing.T) *restRig {
	t.Helper()
	router := chi.NewRouter()
	api.MountDMRoutes(router, r.svc, r.hub, nil, nil)
	api.MountNSFWRoutes(router, r.svc, r.hub)
	api.MountProfileRoutes(router, r.svc, nil, auth.NewRateLimiter(), nil, r.hub, nil)
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)
	return &restRig{url: srv.URL}
}

// do sends one authenticated REST request and fails the test on any status
// other than want.
func (rr *restRig) do(t *testing.T, method, path, token string, body any, want int) {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshalling %s %s body: %v", method, path, err)
		}
		rdr = bytes.NewReader(raw)
	} else {
		rdr = bytes.NewReader(nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), frameDeadline)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, rr.url+path, rdr)
	if err != nil {
		t.Fatalf("building %s %s: %v", method, path, err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != want {
		t.Fatalf("%s %s = %d, want %d", method, path, resp.StatusCode, want)
	}
}

// fixtureClientMessageUUID is the random half of a client_message_id: the
// service wants "<13-digit unix ms>:<uuid v4>" stamped within the last day, so
// the first half is taken from the clock and the echoed id is normalised.
const fixtureClientMessageUUID = "6f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f"

// journeyChatForwardPin records a forward of an existing message into a DM and
// the pin/unpin broadcast for that message.
//
// chat_forward answers like chat_send: the sender's direct chat_forward_ok,
// then the sequenced chat_message for the target (here the alice/bob DM, so bob
// receives it without focusing it). Bob trusts alice, so no dm_request
// replaces the message. chat_pinned is the hub fan-out the pin route calls
// (Hub.BroadcastMessagePinned), sequenced on the message's channel, so both
// focused sockets get it — once for pin, once for unpin. Each trigger is
// fully read on both sockets before the next, so no cross-trigger ordering is
// part of the fixture.
func journeyChatForwardPin(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	ctx := context.Background()
	msgID, err := r.db.CreateMessage(ctx, textChannelID, aliceID, "message to forward", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	dmChannel, _, err := r.db.GetOrCreateDMChannel(ctx, aliceID, bobID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	if err := r.db.TrustSender(ctx, bobID, aliceID, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}

	a, b := r.recordedPair(t, aliceTok, bobTok, textChannelID)
	a.send(map[string]any{
		"type": "chat_forward",
		"id":   "req-chat-forward-1",
		"payload": map[string]any{
			"channel_id":        dmChannel.ID,
			"message_id":        msgID,
			"client_message_id": fmt.Sprintf("%d:%s", time.Now().UnixMilli(), fixtureClientMessageUUID),
		},
	})
	a.expect("chat_forward_ok")
	a.expect("chat_message")
	b.expect("chat_message")

	for _, pinned := range []bool{true, false} {
		r.hub.BroadcastMessagePinned(textChannelID, msgID, pinned)
		a.expect("chat_pinned")
		b.expect("chat_pinned")
	}
	a.barrier()
	b.barrier()
}

// journeyChatPoll records a poll's life: a creates it, b votes, removes the
// vote and votes again, and a ends it. Every vote and the end reach both
// focused sockets as a sequenced poll_update with the full counts and the
// version, and the voter alone gets poll_vote_ok.
func journeyChatPoll(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)
	a, b := r.recordedPair(t, aliceTok, bobTok, textChannelID)
	a.send(map[string]any{
		"type": "poll_create",
		"id":   "req-poll-create-1",
		"payload": map[string]any{
			"client_message_id": fmt.Sprintf("%d:%s", time.Now().UnixMilli(), fixtureClientMessageUUID),
			"channel_id":        textChannelID,
			"question":          "Lunch?",
			"answers":           []map[string]any{{"text": "Pizza", "emoji": "🍕"}, {"text": "Sushi"}},
			"duration_hours":    24,
			"allow_multiselect": false,
		},
	})
	created := a.expect("poll_create_ok")
	a.expect("chat_message")
	b.expect("chat_message")
	pollID, err := created["payload"].(map[string]any)["message_id"].(json.Number).Int64()
	if err != nil {
		t.Fatalf("poll_create_ok message_id: %v", err)
	}

	for i, ids := range [][]int{{1}, {}, {2}} {
		b.send(map[string]any{
			"type":    "poll_vote",
			"id":      fmt.Sprintf("req-poll-vote-%d", i+1),
			"payload": map[string]any{"message_id": pollID, "answer_ids": ids},
		})
		b.expect("poll_vote_ok")
		a.expect("poll_update")
		b.expect("poll_update")
	}
	a.send(map[string]any{"type": "poll_end", "id": "req-poll-end-1", "payload": map[string]any{"message_id": pollID}})
	a.expect("poll_end_ok")
	a.expect("poll_update")
	b.expect("poll_update")
	a.barrier()
	b.barrier()
}

// journeyChatForumPost records a forum post's creation: a declares the forums
// feature and posts to a forum with one tag. The creator gets forum_post_create_ok
// carrying the thread, its post block and the opening message; nothing is
// broadcast to a connection that is not subscribed to the new thread or the
// forum, so the transcript ends with the barrier. The post makes a a follower,
// and the coalescer's leading flush tells it so with a thread_follow_update on
// the low queue. That frame races the barrier's pong, so it is read, checked
// and left out of the transcript before the barrier is sent.
func journeyChatForumPost(t *testing.T, r *epochRig) {
	_, _, aliceTok, _ := r.seedBaseline(t)
	ctx := context.Background()
	forumID, err := r.db.CreateChannel(ctx, "ideas", "forum", "", "", 2)
	if err != nil {
		t.Fatalf("CreateChannel(ideas): %v", err)
	}
	tags, err := r.db.ReplaceForumSettings(ctx, forumID, db.ForumSettingsWrite{
		DefaultAutoArchiveMinutes: 1440, Tags: []db.ForumTagWrite{{Name: "idea"}},
	})
	if err != nil {
		t.Fatalf("ReplaceForumSettings: %v", err)
	}
	a := r.dial(t, "a")
	a.send(map[string]any{
		"type":    "auth",
		"id":      "req-auth-a",
		"payload": map[string]any{"token": aliceTok, "last_seq": 0, "features": []string{"forums"}},
	})
	a.drain("auth_ok", "ready", "member_join", "presence_batch")

	a.record = true
	a.send(map[string]any{
		"type": "forum_post_create",
		"id":   "req-forum-post-1",
		"payload": map[string]any{
			"client_message_id": fmt.Sprintf("%d:%s", time.Now().UnixMilli(), fixtureClientMessageUUID),
			"channel_id":        forumID,
			"name":              "Dark mode",
			"content":           "Please add a dark theme.",
			"tag_ids":           []int64{tags[0].ID},
		},
	})
	a.expect("forum_post_create_ok")
	if got := a.readRaw()["type"]; got != "thread_follow_update" {
		t.Fatalf("conn %q: expected the creator's thread_follow_update, got %q", a.name, got)
	}
	a.barrier()
}

// journeyChatBulkDelete records the single chat_bulk_deleted a purge sends in
// place of N chat_deleted frames (Hub.BroadcastChatBulkDeleted, which the
// retention and erasure paths call). It is sequenced on the channel, so both
// focused sockets receive it. Its ids array is NOT normalised (the key is
// "ids", not "*_id"); the values are the first three message ids of a freshly
// migrated database, so they are deterministic.
func journeyChatBulkDelete(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)
	ids := make([]int64, 0, 3)
	for _, text := range []string{"one", "two", "three"} {
		id, err := r.db.CreateMessage(context.Background(), textChannelID, aliceID, text, nil)
		if err != nil {
			t.Fatalf("CreateMessage(%s): %v", text, err)
		}
		ids = append(ids, id)
	}

	a, b := r.connectPair(t, aliceTok, bobTok)
	// Both sockets wait for their subscription: nothing a sends afterwards
	// orders the hub's broadcast behind a's focus (unlike chat-forward-pin,
	// where a's own chat_forward does), so an unconfirmed focus is a flake.
	// Two pings for a within a second is the per-user ceiling (see barrier).
	a.focus(textChannelID, true)
	b.focus(textChannelID, true)

	a.record, b.record = true, true
	r.hub.BroadcastChatBulkDeleted(textChannelID, ids)
	a.expect("chat_bulk_deleted")
	b.expect("chat_bulk_deleted")
	a.barrier()
	b.barrier()
}

// nsfwChannelID is the labelled channel mention-count-nsfw-ack seeds; the
// baseline holds channels 1 and 2.
const nsfwChannelID = 3

// journeyMentionCountNSFWAck records two targeted, unsequenced frames to bob.
//
// mention_count is what the mention service sends when it bumps a reader's
// total (Hub.NotifyMentionCount); it is only delivered to a reader who can see
// the channel. nsfw_ack is what the acknowledge route sends to the caller's
// live sockets, and the revoke route sends the same frame with
// acknowledged:false — driven here through the real REST handlers over the
// rig's hub, so the frame's shape is the handler's own. alice is connected but
// idle: neither frame is hers, so her only recorded frames are the barrier.
// Both are low-priority, read before the barrier (see the section comment).
func journeyMentionCountNSFWAck(t *testing.T, r *epochRig) {
	_, bobID, aliceTok, bobTok := r.seedBaseline(t)
	ctx := context.Background()
	id, err := r.db.CreateChannel(ctx, "adults", "text", "", "", 3)
	if err != nil {
		t.Fatalf("CreateChannel(adults): %v", err)
	}
	if id != nsfwChannelID {
		t.Fatalf("nsfw channel id = %d, want %d", id, nsfwChannelID)
	}
	if err := r.db.AdminUpdateChannel(ctx, id, db.ChannelUpdate{Name: "adults", Position: 3, NSFW: true}); err != nil {
		t.Fatalf("AdminUpdateChannel(nsfw): %v", err)
	}
	rest := r.mountREST(t)

	a, b := r.recordedPair(t, aliceTok, bobTok)
	r.hub.NotifyMentionCount(bobID, textChannelID, 2)
	b.expect("mention_count")

	nsfwPath := "/api/v1/channels/3/nsfw-acknowledgement"
	rest.do(t, http.MethodPut, nsfwPath, bobTok, nil, http.StatusNoContent)
	b.expect("nsfw_ack")
	rest.do(t, http.MethodDelete, nsfwPath, bobTok, nil, http.StatusNoContent)
	b.expect("nsfw_ack")
	a.barrier()
	b.barrier()
}

// journeyChatCommandUnknown records a slash command nothing owns: the hub in
// this rig has no plugin registry, so the dispatcher answers with an error
// rather than a command_reply. This is the only chat_command outcome that does
// not depend on the build tag — with the wazero runtime absent a registered
// plugin answers with a reply naming the missing runtime, and a reply or
// plugin_broadcast needs a compiled guest module — so command_reply and
// plugin_broadcast are NOT frozen here (see the WP 7.3b report).
func journeyChatCommandUnknown(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.recordedPair(t, aliceTok, bobTok)
	a.send(map[string]any{
		"type": "chat_command",
		"id":   "req-chat-command-1",
		"payload": map[string]any{
			"channel_id": textChannelID,
			"command":    "/nosuchcommand",
			"args":       []string{"one", "two"},
		},
	})
	a.expect("error")
	a.barrier()
	b.barrier()
}

// journeyChannelCRUD records the three channel frames an admin edit produces,
// for a channel the baseline does not have. The database change is made first
// and then the hub method the admin handler calls
// (BroadcastChannelCreate/Update/Delete) — the REST admin routes are not part
// of this harness. channel_create is sent to each reader with that reader's
// own affordance verdicts (can_send ... can_react), so alice and bob carry
// their own copies; channel_update is one sequenced broadcast; channel_delete
// is the bare id. Every trigger is read on both sockets before the next.
func journeyChannelCRUD(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)
	ctx := context.Background()

	a, b := r.connectPair(t, aliceTok, bobTok)

	id, err := r.db.CreateChannel(ctx, "announcements", "text", "Info", "fixture topic", 3)
	if err != nil {
		t.Fatalf("CreateChannel(announcements): %v", err)
	}
	ch, err := r.db.GetChannel(ctx, id)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}

	a.record, b.record = true, true
	r.hub.BroadcastChannelCreate(ch)
	a.expect("channel_create")
	b.expect("channel_create")

	if err := r.db.AdminUpdateChannel(ctx, id, db.ChannelUpdate{
		Name: "news", Topic: "edited topic", CategoryID: ch.CategoryID, SlowMode: 10, Position: 3, VoiceMaxVideo: 25,
	}); err != nil {
		t.Fatalf("AdminUpdateChannel: %v", err)
	}
	if ch, err = r.db.GetChannel(ctx, id); err != nil {
		t.Fatalf("GetChannel(updated): %v", err)
	}
	r.hub.BroadcastChannelUpdate(ch)
	a.expect("channel_update")
	b.expect("channel_update")

	if err := r.db.AdminDeleteChannel(ctx, id); err != nil {
		t.Fatalf("AdminDeleteChannel: %v", err)
	}
	r.hub.BroadcastChannelDelete(id)
	a.expect("channel_delete")
	b.expect("channel_delete")
	a.barrier()
	b.barrier()
}

// journeyDMOpenClose records a DM appearing in the recipient's sidebar and
// disappearing from the closer's, through the real REST handlers over the
// rig's hub. alice creates the DM with bob, who already trusts her, so bob
// (and only bob) gets dm_channel_open — the creator learns from the REST
// response. alice then closes it, which sends dm_channel_close to her alone.
// Both frames are targeted and unsequenced.
func journeyDMOpenClose(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	if err := r.db.TrustSender(context.Background(), bobID, aliceID, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}
	rest := r.mountREST(t)

	a, b := r.recordedPair(t, aliceTok, bobTok)
	rest.do(t, http.MethodPost, "/api/v1/dms", aliceTok, map[string]any{"recipient_id": bobID}, http.StatusCreated)
	b.expect("dm_channel_open")

	rest.do(t, http.MethodDelete, "/api/v1/dms/3", aliceTok, nil, http.StatusNoContent)
	a.expect("dm_channel_close")
	a.barrier()
	b.barrier()
}

// configureUploadFileTypes gives the hub the settings-backed upload policy
// source Hub.BroadcastUploadPolicy needs; without one the broadcast is a no-op.
func configureUploadFileTypes(opts *ws.HubOptions) {
	opts.UploadFileTypes = fixtureFileTypes{}
}

type fixtureFileTypes struct{}

func (fixtureFileTypes) FileTypePolicy(context.Context) (storage.FileTypePolicy, error) {
	return storage.FileTypePolicy{Blocked: []string{"bat", "exe"}, Allowed: []string{}}, nil
}

// journeyServerAdminBroadcasts records the server-wide frames, each reaching
// both sockets: emoji_update (the full custom-emoji set, Hub.BroadcastEmojiUpdate
// as the emoji handlers call it), upload_policy (both lists, always arrays;
// unsequenced), server_restart (the update announcement; the redial spread
// scales with the two connected clients) and presence — alice's own
// presence_update answered by the broadcast of her new status to everyone,
// herself included. presence is the low-priority frame the file header warns
// about: it is read on both sockets before the barrier's ping is sent, so the
// pong has nothing to overtake.
func journeyServerAdminBroadcasts(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)
	emoji, err := r.db.CreateEmoji(context.Background(), "fixture", "fixture.png", "image/png", aliceID)
	if err != nil {
		t.Fatalf("CreateEmoji: %v", err)
	}

	a, b := r.recordedPair(t, aliceTok, bobTok)
	r.hub.BroadcastEmojiUpdate([]*db.Emoji{emoji})
	a.expect("emoji_update")
	b.expect("emoji_update")

	r.hub.BroadcastUploadPolicy()
	a.expect("upload_policy")
	b.expect("upload_policy")

	r.hub.BroadcastServerRestart(ws.RestartReasonUpdate, 30)
	a.expect("server_restart")
	b.expect("server_restart")

	a.send(map[string]any{"type": "presence_update", "payload": map[string]any{"status": "idle"}})
	a.expect("presence")
	b.expect("presence")
	a.barrier()
	b.barrier()
}

// journeyModerationQueue records the moderation fan-out for one report and one
// appeal. alice is promoted to Admin (a moderation-bit holder, so she is in the
// queue audience); bob is the reporter and the appellant, so he is excluded
// from the queue frames about his own report and appeal. carol is the reported
// user and never connects.
//
//   - mod_queue (report form): what the report route calls after filing
//     (Hub.BroadcastModQueue). Only alice receives it.
//   - mod_action: alice warns bob through the real moderation service, wired to
//     the hub as api/router.go wires it. Only bob receives it; expires_at is
//     null for a warning (the timeout form also emits member_timeouts and a
//     channel refresh, which belong to the role/permission fan-out frames and
//     are not frozen here).
//   - mod_queue (appeal form) and appeal_status: bob appeals the warning and
//     alice assigns and decides it, through the real appeal service. The appeal
//     queue frames go to alice, the status frames to bob; each step is read
//     before the next so no cross-connection order is part of the fixture.
//
// All four frames are low-priority and unsequenced, read before the barrier.
func journeyModerationQueue(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)
	carolID, _ := r.seedUser(t, "carol")
	ctx := context.Background()
	r.svc.Moderation.SetNotifier(r.hub)
	r.svc.Appeals.SetNotifier(r.hub)
	r.svc.Appeals.SetQueueBroadcaster(r.hub)

	reportID, err := r.db.FileReport(ctx, "fixture-report", bobID, carolID, "user", "1", nil, "spam", "", nil)
	if err != nil {
		t.Fatalf("FileReport: %v", err)
	}

	a, b := r.recordedPair(t, aliceTok, bobTok)
	r.hub.BroadcastModQueue(ctx, reportID, "open")
	a.expect("mod_queue")

	actionID, err := r.svc.Moderation.Warn(ctx, aliceID, bobID, "fixture warning", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	b.expect("mod_action")

	appealID, err := r.svc.Appeals.Submit(ctx, bobID, actionID, "please reconsider")
	if err != nil {
		t.Fatalf("Appeals.Submit: %v", err)
	}
	a.expect("mod_queue")

	if err := r.svc.Appeals.Assign(ctx, aliceID, appealID, false); err != nil {
		t.Fatalf("Appeals.Assign: %v", err)
	}
	a.expect("mod_queue")
	b.expect("appeal_status")

	if err := r.svc.Appeals.Decide(ctx, aliceID, appealID, "overturned", "fixture decision"); err != nil {
		t.Fatalf("Appeals.Decide: %v", err)
	}
	a.expect("mod_queue")
	b.expect("appeal_status")
	a.barrier()
	b.barrier()
}
