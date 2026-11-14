package app

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/externalcontent"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/unfurl"
	"github.com/J3vb/OwnCord/Server/ws"
)

// linkPreviewJoinBudget bounds the close step's wait for the unfurl workers, which finish the
// fetch they are in (each is bounded by the fetch policy's deadline) and stop.
const linkPreviewJoinBudget = 15 * time.Second

// previewAnnouncer turns an unfurled message into a message_link_previews frame for the
// audience a chat_edited for that message reaches.
type previewAnnouncer struct {
	log  *slog.Logger
	hub  *ws.Hub
	msgs *service.MessageService
}

// LinkPreviewsReady implements unfurl.Announcer. A message whose audience cannot be read is
// not announced: readers get its cards with the next history page.
func (a previewAnnouncer) LinkPreviewsReady(ctx context.Context, r unfurl.Ready) {
	isDM, participants, err := a.msgs.LinkPreviewAudience(ctx, r.ChannelID, r.AuthorID)
	if err != nil {
		a.log.Warn("link previews: audience unavailable", "message_id", r.MessageID, "error", err)
		return
	}
	a.hub.LinkPreviewsChanged(ctx, ws.LinkPreviewUpdate{
		MessageID: r.MessageID, ChannelID: r.ChannelID, IsDM: isDM, ParticipantIDs: participants, Version: r.Version, Cards: r.Cards,
	})
}

// startLinkPreviews runs the unfurl workers over the shared link preview store and hands the
// message service their queue. Without a store, or with the broker's policies refused, there
// is nothing to run and messages are sent as before.
func (a *App) startLinkPreviews() error {
	svc := a.runtime.Services
	if a.linkPreviews == nil || svc == nil || svc.Messages == nil || a.hub == nil {
		return nil
	}
	broker, err := externalcontent.New(externalcontent.DefaultPagePolicy, externalcontent.DefaultImagePolicy)
	if err != nil {
		a.log.Warn("link previews disabled: the fetch policies were refused", "error", err)
		return nil
	}
	u := unfurl.New(a.linkPreviews, unfurl.BrokerSource{Broker: broker},
		previewAnnouncer{log: a.log, hub: a.hub, msgs: svc.Messages},
		unfurl.Options{
			Enabled:       a.cfg.LinkPreviews.Enabled,
			ThumbCapBytes: int64(a.cfg.LinkPreviews.ThumbnailCacheMB) << 20,
			Log:           a.log,
		})
	ctx, cancel := context.WithCancel(a.bgCtx)
	wait := u.Start(ctx)
	svc.Messages.SetLinkUnfurler(u)
	a.onCloseWithin("link-previews", linkPreviewJoinBudget, func(closeCtx context.Context) error {
		cancel()
		if !wait(closeCtx) {
			a.log.Warn("link preview workers did not stop before the close budget ran out")
		}
		return nil
	})
	return nil
}
