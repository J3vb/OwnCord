package ws

import (
	"context"

	"github.com/owncord/server/service"
)

// registerReactionHandlers registers reaction_add and reaction_remove V2 handlers.
func registerReactionHandlers(r *HandlerRegistry, deps ReactionDeps) {
	r.RegisterV2(MsgTypeReactionAdd, reactionV2Handler(true), deps)
	r.RegisterV2(MsgTypeReactionRemove, reactionV2Handler(false), deps)
}

// reactionV2Handler returns a V2 handler for reaction_add (add=true) or
// reaction_remove (add=false). Both share identical validation and routing.
func reactionV2Handler(add bool) HandlerV2 {
	return func(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
		d := deps.(ReactionDeps)
		userID := info.UserID

		var msgID int64
		var emoji string
		if add {
			c := cmd.(ReactionAddCmd)
			msgID = c.MessageID()
			emoji = c.Emoji()
		} else {
			c := cmd.(ReactionRemoveCmd)
			msgID = c.MessageID()
			emoji = c.Emoji()
		}

		var result *service.ReactionResult
		var err error
		if add {
			result, err = d.MessageSvc.AddReaction(ctx, userID, msgID, emoji)
		} else {
			result, err = d.MessageSvc.RemoveReaction(ctx, userID, msgID, emoji)
		}
		if err != nil {
			return serviceErrorToResult(err)
		}

		reactionPayload := buildReactionUpdate(result.MessageID, result.ChannelID, result.UserID, result.Emoji, result.Action)
		if result.IsDM {
			return Result{Events: []Event{ReactionDMEvent{
				channelID:      result.ChannelID,
				participantIDs: result.ParticipantIDs,
				payload:        reactionPayload,
			}}}
		}
		return Result{Events: []Event{ReactionChannelEvent{
			channelID: result.ChannelID,
			payload:   reactionPayload,
		}}}
	}
}
