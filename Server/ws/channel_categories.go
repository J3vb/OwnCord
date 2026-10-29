package ws

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// channelCategoryPayload is one entry of the channel_categories frame and of
// ready's categories.
type channelCategoryPayload struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Position int    `json:"position"`
}

// channelCategoriesPayload is the channel_categories frame's payload. It
// REPLACES the manager's list wholesale, as roles_update does.
type channelCategoriesPayload struct {
	Categories []channelCategoryPayload `json:"categories"`
}

// categoryPayloads maps the stored categories to their wire shape. Always
// non-nil, so the wire never carries a bare null.
func categoryPayloads(cats []db.ChannelCategory) []channelCategoryPayload {
	out := make([]channelCategoryPayload, 0, len(cats))
	for i := range cats {
		out = append(out, channelCategoryPayload{ID: cats[i].ID, Name: cats[i].Name, Position: cats[i].Position})
	}
	return out
}

func buildChannelCategories(cats []db.ChannelCategory) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChannelCategories,
		Payload: channelCategoriesPayload{Categories: categoryPayloads(cats)},
	})
}

// readyCategories resolves ready's categories slot: the full list for a
// viewer who holds MANAGE_CHANNELS (permissions.CanManageChannels,
// Administrator included), nil for everyone else, so a hidden or empty
// category's name never reaches a non-manager. sub is the viewer's role-only
// Subject (readReady already holds it). A read failure fails that ready, like
// the other reads in it.
func (h *Hub) readyCategories(ctx context.Context, database ReadySnapshotReader, sub permissions.Subject) (*[]channelCategoryPayload, error) {
	manages := permissions.CanManageChannels(sub) == nil
	if !manages {
		return nil, nil
	}
	cats, err := database.ListChannelCategories(ctx)
	if err != nil {
		return nil, fmt.Errorf("buildReady ListChannelCategories: %w", err)
	}
	out := categoryPayloads(cats)
	return &out, nil
}

// categoryVerdictBudget bounds one BroadcastChannelCategories pass; a lookup
// that runs past it fails, and that client is skipped.
const categoryVerdictBudget = 5 * time.Second

// BroadcastChannelCategories sends the full category list to every connected
// client that may manage channels, and to nobody else. The permission is
// evaluated here, per client, at send time (a role edited a moment ago is
// honoured), outside every hub lock; sendMsg only queues. The frame is
// identical for every manager, so it is encoded once.
//
// The frames are unsequenced and targeted, so the fan-out is bracketed by
// begin/endTargetedFanout: a manager mid-reconnect resumes onto a full ready
// (which carries categories) instead of replaying past the change. A client
// whose permission lookup fails is skipped and logged; the next category
// event or its next ready settles it.
//
// Ordering: callers send the channel_update frames first, but those go
// through the broadcast queue while this frame is queued straight to the
// manager's connection, so the list can reach a manager before the
// channel_update frames that precede it. Clients must not depend on that
// order: channels carry their own category fields, and this list only
// replaces the manager's category set.
func (h *Hub) BroadcastChannelCategories(cats []db.ChannelCategory) {
	h.beginTargetedFanout()
	defer h.endTargetedFanout()
	ctx, cancel := context.WithTimeout(context.Background(), categoryVerdictBudget)
	defer cancel()
	frame := buildChannelCategories(cats)

	h.mu.RLock()
	ids := h.connectedUserIDsLocked()
	h.mu.RUnlock()

	for _, uid := range ids {
		sub, err := h.subjectFor(ctx, uid, 0)
		if err != nil {
			slog.Warn("hub: channel_categories verdict unknown, user skipped", "user_id", uid, "err", err)
			continue
		}
		if permissions.CanManageChannels(sub) != nil {
			continue
		}
		for _, live := range h.clientsOf(uid) {
			live.sendMsg(frame)
		}
	}
}
