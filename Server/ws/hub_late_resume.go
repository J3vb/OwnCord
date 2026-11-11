package ws

// A recipients frame (channel_update, voice_state, voice_leave) is addressed to
// the users connected when its producer resolved the audience, off the dispatch
// goroutine. A connection that resumes between that moment and the frame's
// delivery is in neither the list nor its own replay. This file closes that gap
// at delivery, under seqMu.

import "slices"

// audienceMark names the present set of connections, for a producer about to
// resolve an audience from the connected users. A connection registered after
// the read has regGen >= the mark. Never zero, which means no mark.
func (h *Hub) audienceMark() uint64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.connGen.Load() + 1
}

// lateResumes lists the connections that resumed after mark was read and whose
// replay would have carried a frame of channelID: the channel is in the set that
// replay was filtered by or, for a voice frame only, holds the call the resume
// inherited (the voice supplement of handleReconnect, which passes nothing but
// voice_state and voice_leave). Their users were not connected when the audience
// was resolved, and the frame's seq comes after their replay, so without this
// they never see it: a client acks only max(seq). A connection of a user in
// recipients is left out (SendToUser reaches it), and so is a fresh connect, whose
// ready is read from the database after it registered. The caller holds seqMu,
// which is what orders this against reconnectRegister.
func (h *Hub) lateResumes(mark uint64, channelID int64, recipients []int64, voiceFrame bool) []*Client {
	if mark == 0 || h.connGen.Load() < mark {
		return nil
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	var late []*Client
	for _, list := range h.clients {
		for _, c := range list {
			if c.regGen < mark || c.resumeReadable == nil {
				continue
			}
			if !c.resumeReadable[channelID] && (!voiceFrame || c.voice.channel() != channelID) {
				continue
			}
			if !slices.Contains(recipients, c.userID) {
				late = append(late, c)
			}
		}
	}
	return late
}

// sendToLateResumes delivers a sequenced recipients frame to lateResumes. The
// caller holds seqMu.
func (h *Hub) sendToLateResumes(mark uint64, channelID int64, recipients []int64, msg []byte) {
	if mark == 0 {
		return
	}
	for _, c := range h.lateResumes(mark, channelID, recipients, isVoiceRosterFrame(msg)) {
		c.trySendMsg(msg)
	}
}

// isVoiceRosterFrame reports whether msg is one of the two frames a call's
// members receive whether or not they may read its channel.
func isVoiceRosterFrame(msg []byte) bool {
	switch extractEventType(msg) {
	case MsgTypeVoiceState, MsgTypeVoiceLeaveBC:
		return true
	}
	return false
}
