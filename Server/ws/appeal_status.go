package ws

// appealStatusPayload is the appeal_status frame's payload (B5-10):
// targeted at the appellant only, unsequenced, not replayed. decisionNote
// is nil until the appeal is decided.
type appealStatusPayload struct {
	ID           string  `json:"id"`
	State        string  `json:"state"`
	DecisionNote *string `json:"decision_note"`
}

func buildAppealStatus(publicID, state string, decisionNote *string) []byte {
	return buildJSON(wsMsg{Type: MsgTypeAppealStatus, Payload: appealStatusPayload{
		ID: publicID, State: state, DecisionNote: decisionNote,
	}})
}

// NotifyAppealStatus delivers a live appeal_status frame to userID (the
// appellant), satisfying service.AppealStatusNotifier. Targeted and
// unsequenced (SendToUserLow, mirroring NotifyModAction/BroadcastModQueue):
// a disconnected appellant simply sees the new state on their next
// GET /api/v1/appeals/mine, so a missed frame here costs nothing.
func (h *Hub) NotifyAppealStatus(userID int64, publicID, state string, decisionNote *string) {
	h.SendToUserLow(userID, buildAppealStatus(publicID, state, decisionNote))
}
