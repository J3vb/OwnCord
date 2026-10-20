package service

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// SetBackground installs the group SendMessage's background jobs run on. The
// composition root calls it once at start-up (app.startHub) before the
// service is shared; its close step stops the group before the database
// closes. A nil group keeps the unowned default.
func (s *MessageService) SetBackground(g *syncutil.Group) { s.bg = g }

// runBackground runs fn on the background group, or inline under
// RunBackgroundInlineForTest. fn gets ctx's values and the group's
// cancellation, never ctx's own, so it applies its own deadline. A job
// refused because shutdown has begun is dropped: nothing may start once the
// database is about to close.
func (s *MessageService) runBackground(ctx context.Context, what string, fn func(context.Context)) {
	if s.bgInline {
		fn(ctx)
		return
	}
	if !s.bg.Go(ctx, fn) {
		slog.DebugContext(ctx, "background job skipped: shutdown in progress", "job", what)
	}
}
