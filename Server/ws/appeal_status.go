package ws

// appealStatusPayload is the appeal_status frame: targeted at the appellant only,
// unsequenced, not replayed.
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

// NotifyAppealStatus delivers a live appeal_status frame to the appellant
// (service.AppealStatusNotifier).
// Unsequenced: a missed frame is covered by the appellant's next GET
// /api/v1/appeals/mine.
func (h *Hub) NotifyAppealStatus(userID int64, publicID, state string, decisionNote *string) {
	h.SendToUserLow(userID, buildAppealStatus(publicID, state, decisionNote))
}
