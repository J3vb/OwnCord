package ws

import "log/slog"

// Register queues a client for registration with the hub.
func (h *Hub) Register(c *Client) {
	h.clientEvents <- clientEvent{c: c, add: true}
}

// Unregister queues a client for removal from the hub.
func (h *Hub) Unregister(c *Client) {
	h.clientEvents <- clientEvent{c: c}
}

// registerNow adds c to the hub and subscribes it to its topics.
//
// readableChannelIDs is the set of channels the user holds READ_MESSAGES on,
// as computed by the handshake (serve.go). It gates the inherited voice-channel
// subscription only; a nil set denies it (fail closed).
//
// Replacing an existing connection strips its subscriptions (UnsubscribeAll)
// and re-subscribes the new one (Subscribe) as two separate PubSub-lock
// acquisitions — back to back, but not atomic. A caller that must not lose a
// broadcast concurrently racing the replacement (i.e. one deliverBroadcast
// could deliver in the gap between those two acquisitions) has to call this
// while holding h.seqMu, the same lock deliverBroadcast holds for its entire
// critical section (seq allocation, replay-buffer push, and publish) — that
// serializes the two entirely, rather than merely narrowing the window. See
// serve.go's handleReconnect, which re-reads the replay tail and calls
// registerNow inside one h.seqMu section for exactly this reason.
func (h *Hub) registerNow(c *Client, readableChannelIDs map[int64]bool) {
	// Voice channel the replaced connection was in, if any. Re-elected below,
	// after the hub lock is released.
	var replacedVoiceChID int64

	h.mu.Lock()
	if old, exists := h.clients[c.userID]; exists {
		oldE2EEKey, oldE2EESig := old.getE2EEPubKey()
		oldVoiceChID, oldVoiceJoinToken, oldVoiceJoinCompleted := old.clearVoiceState()
		replacedVoiceChID = oldVoiceChID
		// A moderator-imposed mute/deafen stashed by voice_mod_move
		// (setPendingModFlags) lives ONLY on the old *Client between the
		// target's eviction (which deletes the voice_states row that state
		// normally lives in) and the target's own re-join, which consumes it
		// via takePendingModFlags (voice_join.go). Any client replacement —
		// reconnect or full resync alike — must carry it to the new *Client
		// or it is silently destroyed and the mute is lost (OC-0302).
		// Unlike the voice-state transfer below, this has none of the
		// voiceJoinCompleted supersession concerns, so it is not gated on
		// c.lastSeq > 0: take-and-clear leaves nothing behind for old to
		// double-serve, and a stash nobody set is always (false, false).
		if pendingMuted, pendingDeafened := old.takePendingModFlags(); pendingMuted || pendingDeafened {
			c.setPendingModFlags(pendingMuted, pendingDeafened)
		}
		if c.lastSeq > 0 {
			// Network reconnect — preserve voice state so the user stays
			// in voice during brief WS drops.
			//
			// Gated on oldVoiceJoinCompleted (OC-0270): a join that
			// voiceJoinPersist has merely committed to the DB and set on the
			// old client, but that voiceJoinComplete has not yet finished, is
			// still racing its own supersession guards in voice_join.go
			// (voice_join.go:423, :470) — both compare the old client's live
			// voiceChID/voiceJoinToken against the values captured when the
			// join started. Clearing the old client's state above as part of
			// this very transfer makes those guards read as "superseded" and
			// abort the join (no token delivered, no voice_state broadcast,
			// no VoiceTopic subscribe) — while the DB row and the new
			// client's transferred state still agree, so sweepStaleVoiceStates
			// never reaps it. Transferring only a completed join avoids
			// resurrecting exactly that half-finished state; an incomplete
			// one instead leaves the new client with voiceChID 0, so the
			// still-committed row now disagrees with hub state and the next
			// sweep tick reaps it, letting the user rejoin.
			if c.getVoiceChID() == 0 && oldVoiceJoinCompleted {
				c.setVoiceState(oldVoiceChID, oldVoiceJoinToken)
				// c.setVoiceState above resets the fresh-join-in-progress flag
				// it defaults to; restore it since we just verified the old
				// client's join over this same (chID, token) had completed.
				c.markVoiceJoinCompleteIfMatch(oldVoiceChID, oldVoiceJoinToken)
				// The announced ECDH key must survive with the voice state:
				// the client keeps its keypair across a WS blip and only
				// re-announces on a LiveKit-room reconnect, so without the
				// transfer voice_join replays nothing for this user and new
				// joiners' key exchanges time out.
				c.setE2EEPubKey(oldE2EEKey, oldE2EESig)
			}
			// The focused channel must transfer too: the client never
			// re-sends channel_focus on a resume (mountChannel early-returns
			// on the same channel), so without it the ChannelTopic
			// re-subscribe below is a no-op and the message stream dies
			// silently. READ-gated like every ChannelTopic subscription;
			// a nil set denies (fail closed).
			if oldChID := old.getChannelID(); oldChID != 0 &&
				c.getChannelID() == 0 && readableChannelIDs[oldChID] {
				c.mu.Lock()
				c.channelID = oldChID
				c.mu.Unlock()
			}
		}
		// Fresh connections (lastSeq == 0): do NOT transfer voice state.
		// Stale voice cleanup (DB + broadcast + LiveKit) is owned entirely
		// by the handshake path in serve.go, which runs before registerNow.
		// registerNow only handles in-memory client replacement.

		// Kick the stale connection atomically before registering
		// the new one — prevents TOCTOU races on duplicate login.
		// closeSend MUST precede UnsubscribeAll: Subscribe refuses clients
		// whose send is closed, so this ordering leaves the old connection's
		// in-flight handlers no window to re-take a stripped topic.
		slog.Warn("hub: kicking stale connection for re-registering user",
			"user_id", c.userID, "last_seq", c.lastSeq)
		old.closeSend()

		// Remove the old client from all pub/sub topics before replacing.
		h.pubsub.UnsubscribeAll(old)
	}
	h.clients[c.userID] = c

	// Subscribe the new client to its default pub/sub topics immediately
	// after UnsubscribeAll(old) above, with nothing in between.
	//
	// This does NOT make strip+resubscribe atomic, and must not be read as
	// doing so: the two are separate ps.mu acquisitions, and PublishGlobal
	// takes ps.mu alone (never h.mu), so a deliverBroadcast landing between
	// them still finds no subscriber for this user. That frame is
	// unrecoverable — its seq was already allocated and pushed to the replay
	// buffer, the resuming client's replay snapshot was taken even earlier,
	// and the client tracks only max(seq), so the next frame silently
	// advances past the hole. Only a caller holding h.seqMu closes that
	// window; see this function's doc comment and serve.go's handleReconnect.
	//
	// What the ordering does buy is the smallest possible gap for the callers
	// that cannot hold seqMu — the fresh-connect path, whose buildReady
	// rebuilds state from the DB afterwards, and the clientEvents path, which
	// runs on the hub goroutine and so cannot race deliverBroadcast at all.
	// The registration log line (a syscall-backed slog call) and
	// updateKeyHolder (keyHolderMu plus a full h.clients scan under
	// h.mu.RLock) both used to sit in that gap; both now run after the
	// subscribes. Keeping the subscribes under h.mu is incidental but free:
	// pubsub uses its own independent lock and never calls back into the hub,
	// so h.mu → ps.mu adds no lock-ordering risk.
	h.pubsub.Subscribe(c, TopicGlobal)
	h.pubsub.Subscribe(c, UserTopic(c.userID))
	// If the client already has a focused channel (e.g. test clients created with
	// NewTestClientWithChannel, or reconnecting clients), subscribe immediately so
	// deliverBroadcast can reach them without waiting for a channel_focus message.
	if chID := c.getChannelID(); chID != 0 {
		h.pubsub.Subscribe(c, ChannelTopic(chID))
	}
	// If the client is already in a voice channel (e.g. reconnect), restore its
	// subscriptions without a new voice_join (a same-channel rejoin is rejected
	// with ALREADY_JOINED) or channel_focus.
	if voiceChID := c.getVoiceChID(); voiceChID != 0 {
		// VoiceTopic is the only transport for voice_e2ee_announce relays and
		// carries nothing else, for a channel the user already joined via the
		// CONNECT_VOICE-gated voice_join — so no READ gate.
		h.pubsub.Subscribe(c, VoiceTopic(voiceChID))
		// Voice membership is gated on CONNECT_VOICE alone, so it must not by
		// itself grant a channel's message stream: subscribe only when the
		// handshake confirmed READ_MESSAGES on that channel.
		if readableChannelIDs[voiceChID] {
			h.pubsub.Subscribe(c, ChannelTopic(voiceChID))
		}
	}
	total := len(h.clients)
	h.mu.Unlock()

	slog.Info("hub: client registered", "user_id", c.userID, "total_clients", total)

	// A fresh connect (lastSeq == 0) drops the replaced connection's voice state
	// without transferring it, so that channel just lost a participant and the
	// E2EE key holder may need to move. handleVoiceLeave never runs on this path
	// — readPump skips it when replaced, and it early-returns on already-cleared
	// state — so re-elect here. Must be outside h.mu: updateKeyHolder takes
	// keyHolderMu and then h.mu.RLock. The recompute reads live client voice
	// state, so it is idempotent and also correct when the state was transferred.
	// It runs after the subscribe block above; updateKeyHolder only reads
	// h.clients' voice state and writes voiceKeyHolders, so it has no
	// ordering dependency on pub/sub subscriptions.
	if replacedVoiceChID != 0 {
		h.updateKeyHolder(replacedVoiceChID)
	}

	// Re-sync this connection's local E2EE peer-key map now that it is
	// reachable (OC-0276). voice_e2ee_announce is delivered as an
	// unsequenced pub/sub frame (sendToVoiceChannelExcept, voice_e2ee.go),
	// bypassing deliverBroadcast/h.replayBuf entirely — so on a network
	// reconnect (the transfer above), neither reconnect replay tier can ever
	// redeliver a peer's key, or a mid-call key rotation, that was announced
	// while this socket was down. voiceJoinComplete's relay
	// (voice_join.go) only runs on a brand-new voice_join, never here, so
	// without this call a resumed connection's peer-key map would silently
	// and permanently desync from its (correctly replayed) voice roster.
	// c.getVoiceChID() reflects the transfer above, so this covers a
	// resumed connection as well as a client pre-set into a voice channel
	// (e.g. NewTestClientWithChannel); it is a no-op whenever c is not
	// currently in a voice channel, which is the common case (fresh login).
	if voiceChID := c.getVoiceChID(); voiceChID != 0 {
		h.sendVoicePeerKeys(c, voiceChID)
		// Re-relay THIS client's own stored key back onto VoiceTopic (OC-0316).
		// voice_e2ee_offer (the room-key-bearing message) is a targeted,
		// unsequenced send that is silently dropped if this socket was down
		// when it went out (sendToUserIfInVoiceChannel, voice_e2ee.go) — and
		// unlike voice_e2ee_announce it has no reconnect-replay recovery
		// path either. A key rotation sent during the outage otherwise
		// strands this client on a dead key with no signal and no retry
		// until the key holder's next periodic rotation. The client's
		// duplicate-announce handling already re-wraps and re-offers the
		// CURRENT room key whenever it sees a peer announce a key it
		// already knows, so re-announcing our own (unchanged) key is enough
		// to make the key holder re-offer — no client change needed.
		if key, sig := c.getE2EEPubKey(); key != "" {
			h.sendToVoiceChannelExcept(voiceChID, c.userID, buildVoiceE2EEAnnounce(c.userID, key, sig))
		}
	}
}

func (h *Hub) unregisterNow(c *Client) bool {
	h.mu.Lock()
	current, exists := h.clients[c.userID]
	if exists && current == c {
		delete(h.clients, c.userID)
		slog.Info("hub: client unregistered", "user_id", c.userID, "total_clients", len(h.clients))
		h.mu.Unlock()
		h.pubsub.UnsubscribeAll(c)
		return false // not replaced
	}
	h.mu.Unlock()
	// exists means a *different* client holds the slot — a genuine replacement,
	// whose teardown must not mark the live connection's user offline. An absent
	// entry means this client was already kicked (every kick path deletes it via
	// kickClient), which is a real disconnect and still needs the offline
	// presence broadcast and voice cleanup in readPump's defer.
	return exists
}

// shouldMarkOffline reports whether a disconnect teardown should run
// MarkUserDisconnected and broadcast an offline presence for c's user.
//
// `replaced` (unregisterNow's return, sampled once at the start of teardown)
// is necessary but not sufficient: both readPump's defer and
// unregisterFailedHandshake sample it BEFORE handleVoiceLeave, which can
// block for seconds (DB delete, audience scan, a LiveKit call bounded by
// lkTimeout=5s). A reconnect landing during that window registers a new
// client for the same user and is invisible to the stale boolean, so the
// dead connection's teardown would otherwise mark the live session offline
// (OC-0019). Re-checking h.clients at decision time closes that gap: any
// entry present once c has been removed is necessarily a newer connection —
// unregisterNow only ever deletes c's own slot, never someone else's.
func (h *Hub) shouldMarkOffline(c *Client, replaced bool) bool {
	return !replaced && h.GetClient(c.userID) == nil
}
