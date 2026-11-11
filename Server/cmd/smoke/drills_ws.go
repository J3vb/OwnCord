package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// wsFrame is one server→client frame. Payload stays raw: Type decides its structure, and eager decoding would
// turn an unexpected frame into a decode error instead of a readable report.
type wsFrame struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

func (f wsFrame) errCode() (string, string) {
	if f.Type != "error" {
		return "", ""
	}
	var payload struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(f.Payload, &payload); err != nil {
		return "UNREADABLE", string(f.Payload)
	}
	return payload.Code, payload.Message
}

// fullSendOutcome is which bucket one reply to the full stage's chat_send lands in. Phase D asserts every
// send was answered and at least one refused by the full filesystem, so what counts as that refusal decides
// whether it measured the disk.
type fullSendOutcome int

const (
	fullSendAcked     fullSendOutcome = iota // chat_send_ok
	fullSendRefused                          // an error frame that got past the rate limit
	fullSendThrottled                        // RATE_LIMITED: the harness's own pacing
	fullSendSilent                           // nothing arrived, or not an answer to this send
)

// classifyFullSend sorts a chat_send reply. A refusal differs from a throttle: service.sendMessageRateGate
// charges the chat rate limit before reading the channel, so RATE_LIMITED never reached SQLite and says
// nothing about the disk.
func classifyFullSend(frame wsFrame, err error) fullSendOutcome {
	if err != nil {
		return fullSendSilent
	}
	if frame.Type == "chat_send_ok" {
		return fullSendAcked
	}
	if frame.Type != "error" {
		return fullSendSilent
	}
	if code, _ := frame.errCode(); code == errCodeRateLimited {
		return fullSendThrottled
	}
	// Everything else is a refusal, including an unparseable error frame: the rate limiter's reply is always
	// well-formed, so one this drill cannot read came from further in than the precheck.
	return fullSendRefused
}

// voiceGuardRefused is probeVoiceJoin's stop predicate for the post-kill probe: whether the reply is the
// LiveKit-process guard refusing, not any error frame, because voice_join's per-user rate limit is checked
// first and answers RATE_LIMITED.
func voiceGuardRefused(f wsFrame) bool {
	code, _ := f.errCode()
	return code == errCodeVoiceError
}

// wsConn is one authenticated WebSocket session. A pump goroutine reads frames into a buffered channel
// because the interesting ones arrive while the harness is busy (a server_restart lands during a restore
// being waited on).
type wsConn struct {
	conn   *websocket.Conn
	frames chan wsFrame
	closed sync.Once
}

func wsURL(baseURL string) string {
	return strings.Replace(baseURL, "https://", "wss://", 1) + "/api/v1/ws"
}

// dialWS opens a session and completes the auth handshake; an unauthenticated session would make every later
// assertion vacuous.
func dialWS(token string) (*wsConn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), fixtureTimeout)
	defer cancel()
	conn, dialResp, err := websocket.Dial(ctx, wsURL(defaultBaseURL), &websocket.DialOptions{HTTPClient: fixtureClient})
	if dialResp != nil && dialResp.Body != nil {
		// Dial has already closed it (coder/websocket v1.8.15); the guard is here because bodyclose cannot see
		// that, as in api/livekit_proxy.go.
		defer dialResp.Body.Close() //nolint:errcheck // best-effort close of an already-closed body
	}
	if err != nil {
		return nil, fmt.Errorf("dialling %s: %w", wsURL(defaultBaseURL), err)
	}
	w := &wsConn{conn: conn, frames: make(chan wsFrame, 256)}
	go w.pump()

	payload, err := json.Marshal(map[string]any{"token": token, "last_seq": 0})
	if err != nil {
		w.close()
		return nil, err
	}
	if err := wsjson.Write(ctx, conn, wsFrame{Type: "auth", Payload: payload}); err != nil {
		w.close()
		return nil, fmt.Errorf("authenticating a session: %w", err)
	}
	frame, err := w.await(fixtureTimeout, "auth_ok")
	if err != nil {
		w.close()
		return nil, fmt.Errorf("authenticating a session: %w", err)
	}
	if frame.Type != "auth_ok" {
		w.close()
		return nil, fmt.Errorf("authenticating a session: the server answered %q", frame.Type)
	}
	return w, nil
}

// pump moves frames off the socket into the channel until it fails; the close that follows a server_restart
// is an ordinary end, not something to report.
func (w *wsConn) pump() {
	for {
		var frame wsFrame
		err := wsjson.Read(context.Background(), w.conn, &frame)
		if err != nil {
			close(w.frames)
			return
		}
		w.frames <- frame
	}
}

func (w *wsConn) close() {
	w.closed.Do(func() { _ = w.conn.Close(websocket.StatusNormalClosure, "") })
}

func (w *wsConn) send(kind string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), fixtureTimeout)
	defer cancel()
	return wsjson.Write(ctx, w.conn, wsFrame{Type: kind, Payload: raw})
}

// await returns the first frame of a wanted type, dropping the others: sockets also see presence and replay
// traffic, so an unexpected frame must not fail the drill. A wanted type that never arrives is the failure.
func (w *wsConn) await(timeout time.Duration, want ...string) (wsFrame, error) {
	deadline := time.After(timeout)
	for {
		select {
		case frame, ok := <-w.frames:
			if !ok {
				return wsFrame{}, errors.New("the connection closed before any of " + strings.Join(want, ", ") + " arrived")
			}
			if slices.Contains(want, frame.Type) {
				return frame, nil
			}
		case <-deadline:
			return wsFrame{}, errors.New("none of " + strings.Join(want, ", ") + " arrived within " + timeout.String())
		}
	}
}

func (w *wsConn) chatSend(channelID int64, content string) (wsFrame, error) {
	if err := w.send("chat_send", map[string]any{"channel_id": channelID, "content": content}); err != nil {
		return wsFrame{}, err
	}
	return w.await(fixtureTimeout, "chat_send_ok", "error")
}

func (w *wsConn) voiceJoin(channelID int64) (wsFrame, error) {
	if err := w.send("voice_join", map[string]any{"channel_id": channelID}); err != nil {
		return wsFrame{}, err
	}
	return w.await(fixtureTimeout, "voice_token", "error")
}

func wantOK(frame wsFrame, kind string) error {
	if frame.Type == kind {
		return nil
	}
	if code, message := frame.errCode(); code != "" {
		return fmt.Errorf("the server refused with %s: %s", code, message)
	}
	return fmt.Errorf("the server answered %q, want %s", frame.Type, kind)
}
