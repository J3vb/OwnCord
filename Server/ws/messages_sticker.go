package ws

import "github.com/J3vb/OwnCord/Server/service"

// stickerInfo is the client-facing shape of one custom sticker: enough to
// render it and to search for it. The storage id and mime type stay
// server-side -- the image route is the only thing that needs them.
type stickerInfo struct {
	ID    int64   `json:"id"`
	Name  string  `json:"name"`
	Emoji *string `json:"emoji"`
	URL   string  `json:"url"`
}

// stickerUpdatePayload carries the whole sticker set, for the same reason
// emojiUpdatePayload carries the whole emoji set: a wholesale replace cannot
// leave a deleted sticker in a picker after a dropped event.
type stickerUpdatePayload struct {
	Stickers []stickerInfo `json:"stickers"`
}

// buildStickerUpdate constructs a sticker_update broadcast carrying the full
// custom-sticker set, ordered the way the server listed it.
func buildStickerUpdate(list []*service.Sticker) []byte {
	flat := make([]stickerInfo, 0, len(list))
	for _, s := range list {
		if s == nil {
			continue
		}
		flat = append(flat, stickerInfo{
			ID: s.ID, Name: s.Name, Emoji: s.Emoji, URL: service.StickerImageURL(s.ID),
		})
	}
	return buildJSON(wsMsg{
		Type:    MsgTypeStickerUpdate,
		Payload: stickerUpdatePayload{Stickers: flat},
	})
}

// BroadcastStickerUpdate sends the full custom-sticker set to every connected
// client so a newly uploaded, renamed or deleted sticker shows in the picker
// without a reconnect.
//
// Unfiltered, like BroadcastEmojiUpdate: stickers are server-wide with no
// channel scope, and every client may already GET the same list.
func (h *Hub) BroadcastStickerUpdate(list []*service.Sticker) {
	h.BroadcastToAll(buildStickerUpdate(list))
}
