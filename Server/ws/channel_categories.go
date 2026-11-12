package ws

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

type channelCategoryPayload struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Position int    `json:"position"`
}

// channelCategoriesPayload REPLACES the manager's list wholesale, as roles_update
// does.
type channelCategoriesPayload struct {
	Categories []channelCategoryPayload `json:"categories"`
}

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

// readyCategories returns the full list for a viewer holding MANAGE_CHANNELS, nil
// for everyone else so a hidden category name never reaches a non-manager. A read
// failure fails that ready.
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

const categoryVerdictBudget = 5 * time.Second

// BroadcastChannelCategories sends the full list to every connected client that
// may manage channels. The permission is evaluated per client at send time,
// outside every hub lock; the frame is encoded once.
// Unsequenced and targeted, so the fan-out is bracketed by
// begin/endTargetedFanout: a manager mid-reconnect resumes onto a full ready
// instead of replaying past the change. A failed lookup skips and logs that
// client.
// Ordering: channel_update goes through the broadcast queue while this frame is
// queued straight to the connection, so it can arrive first; clients must not
// depend on the order.
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
