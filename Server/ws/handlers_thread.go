package ws

import (
	"context"
	"errors"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// ThreadDeps holds dependencies for the thread handlers.
type ThreadDeps struct {
	Limiter    *auth.RateLimiter
	ThreadSvc  *service.ThreadService
	ChannelSvc *service.ChannelService
}

// registerThreadHandlers registers the five thread commands. A hub without
// Services has no thread service: they answer INTERNAL (threadsUnavailable) and
// ready does not advertise `threads`.
func registerThreadHandlers(r *HandlerRegistry, deps ThreadDeps) {
	r.RegisterV2(MsgTypeThreadCreate, handleThreadCreateV2, deps)
	r.RegisterV2(MsgTypeThreadUpdate, handleThreadUpdateV2, deps)
	r.RegisterV2(MsgTypeThreadDelete, handleThreadDeleteV2, deps)
	r.RegisterV2(MsgTypeThreadFocus, handleThreadFocusV2, deps)
	r.RegisterV2(MsgTypeThreadFollow, handleThreadFollowV2, deps)
}

func threadsUnavailable() Result {
	return Result{Error: ClientError{Code: ErrCodeInternal, Message: "threads are unavailable"}}
}

// threadErrorToResult is serviceErrorToResult plus two thread refusals: a create
// that lost a race names the winner, and a locked thread has its own code.
func threadErrorToResult(err error) Result {
	var exists *service.ThreadExistsError
	switch {
	case errors.As(err, &exists):
		return Result{Error: ClientError{Code: ErrCodeThreadExists, Message: "a thread already exists for this message", ThreadID: exists.ThreadID}}
	default:
		return serviceErrorToResult(err)
	}
}

// handleThreadCreateV2 replies thread_create_ok; every viewer of the parent hears
// thread_changed (coalesced). A retry by the owner replies the same thread and
// announces nothing.
func handleThreadCreateV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ThreadDeps)
	if d.ThreadSvc == nil {
		return threadsUnavailable()
	}
	c := cmd.(ThreadCreateCmd)
	t, created, err := d.ThreadSvc.Create(ctx, service.CreateThreadParams{
		UserID: info.UserID, ChannelID: c.ChannelID, MessageID: c.MessageID, Name: c.Name,
		AutoArchiveMinutes: c.AutoArchiveMinutes,
	})
	if err != nil {
		return threadErrorToResult(err)
	}
	res := Result{Reply: buildThreadCreateOK(info.ReqID, t)}
	if created {
		res.Events = []Event{threadNoteEvt{threadID: t.ID}}
	}
	return res
}

func handleThreadUpdateV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ThreadDeps)
	if d.ThreadSvc == nil {
		return threadsUnavailable()
	}
	c := cmd.(ThreadUpdateCmd)
	t, err := d.ThreadSvc.Update(ctx, service.UpdateThreadParams{
		UserID: info.UserID, ThreadID: c.ThreadID, Name: c.Name, Archived: c.Archived, Locked: c.Locked,
		AutoArchiveMinutes: c.AutoArchiveMinutes, TagIDs: c.TagIDs,
	})
	if err != nil {
		return threadErrorToResult(err)
	}
	return Result{
		Reply:  buildThreadUpdateOK(info.ReqID, t.ID),
		Events: []Event{threadNoteEvt{threadID: t.ID}},
	}
}

// handleThreadDeleteV2: thread_deleted is sequenced on the parent; the note makes
// the hub cancel the thread's pending frame and release every socket that had it
// open.
func handleThreadDeleteV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ThreadDeps)
	if d.ThreadSvc == nil {
		return threadsUnavailable()
	}
	c := cmd.(ThreadDeleteCmd)
	t, followers, err := d.ThreadSvc.DeleteNotifying(ctx, info.UserID, c.ThreadID)
	if err != nil {
		return threadErrorToResult(err)
	}
	// The note comes first: it drops the coalescer entry, so a flush that read
	// the thread before the delete cannot announce it after thread_deleted.
	events := []Event{
		threadNoteEvt{threadID: t.ID, parentID: t.ParentID, deleted: true},
		channelEvt{evType: MsgTypeThreadDeleted, channelID: t.ParentID, payload: buildThreadDeleted(t.ParentID, t.ID)},
	}
	// Each follower's rows went with the thread: tell them they no longer follow
	// it.
	gone := buildThreadFollowUpdate(t.ID, false, nil)
	for _, uid := range followers {
		events = append(events, threadFollowEvt{targetUserID: uid, payload: gone})
	}
	return Result{Events: events}
}

// handleThreadFollowV2 replies thread_follow_ok; the same state goes to the
// sender's socket as thread_follow_update, which is how the thread reaches a
// client that lacked it.
func handleThreadFollowV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ThreadDeps)
	if d.ThreadSvc == nil {
		return threadsUnavailable()
	}
	c := cmd.(ThreadFollowCmd)
	// Own budget (the focus one): following is user-paced.
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("threadfollow", info.UserID), focusRateLimit, focusRateWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many thread follow changes"}}
	}
	t, err := d.ThreadSvc.SetFollow(ctx, info.UserID, c.ThreadID, c.Follow)
	if err != nil {
		return threadErrorToResult(err)
	}
	var shown *service.ThreadInfo
	if c.Follow {
		shown = t
	}
	return Result{
		Reply: buildThreadFollowOK(info.ReqID, t.ID, c.Follow),
		Events: []Event{threadFollowEvt{
			targetUserID: info.UserID, payload: buildThreadFollowUpdate(t.ID, c.Follow, shown),
		}},
	}
}

// handleThreadFocusV2 moves the second subscription slot (null thread_id closes
// it). Opening runs thread-aware admission (the parent's overrides apply) and
// marks the thread read; the applier re-validates after Subscribe
// (applyThreadFocus).
func handleThreadFocusV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ThreadDeps)
	if d.ThreadSvc == nil {
		return threadsUnavailable()
	}
	c := cmd.(ThreadFocusCmd)
	id := c.ThreadID
	if id == 0 {
		return Result{SetThreadID: &id}
	}
	// Own budget: opening and closing a panel is user-paced, so a refused frame
	// is an error, not a deferral.
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("threadfocus", info.UserID), focusRateLimit, focusRateWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many thread focus changes"}}
	}
	if d.ChannelSvc == nil {
		return threadsUnavailable()
	}
	if _, err := d.ChannelSvc.HandleThreadFocus(ctx, info.UserID, id); err != nil {
		switch {
		case errors.Is(err, service.ErrForbidden), errors.Is(err, service.ErrNotFound):
			return serviceErrorToResult(err)
		default:
			return dropUnlessDeadline(ctx, err)
		}
	}
	return Result{SetThreadID: &id, Events: []Event{channelReadEvt(info.UserID, id, readThroughNoted)}}
}

func (h *Hub) wireThreads(reg *HandlerRegistry, svc *service.Services) {
	deps := ThreadDeps{Limiter: h.limiter}
	if svc != nil {
		deps.ThreadSvc, deps.ChannelSvc = svc.Threads, svc.Channels
		h.threadHub.svc = svc.Threads
	}
	registerThreadHandlers(reg, deps)
	if svc != nil && svc.ThreadArchiver != nil {
		svc.ThreadArchiver.SetNotifier(h)
	}
}
