package ws_test

import (
	"encoding/json"
	"testing"

	ws "github.com/owncord/server/ws"
)

func TestBuildVoiceOffer(t *testing.T) {
	msg := ws.BuildVoiceOfferForTest(10, "v=0\r\noffer-sdp")
	var m map[string]any
	if err := json.Unmarshal(msg, &m); err != nil {
		t.Fatal(err)
	}
	if m["type"] != "voice_offer" {
		t.Errorf("type = %v, want voice_offer", m["type"])
	}
	p := m["payload"].(map[string]any)
	if p["channel_id"] != float64(10) {
		t.Errorf("channel_id = %v, want 10", p["channel_id"])
	}
	if p["sdp"] != "v=0\r\noffer-sdp" {
		t.Errorf("sdp = %v", p["sdp"])
	}
}

func TestBuildVoiceICE(t *testing.T) {
	candidate := map[string]any{
		"candidate":     "candidate:1 1 UDP 2130706431 ...",
		"sdpMid":        "0",
		"sdpMLineIndex": float64(0),
	}
	msg := ws.BuildVoiceICEForTest(10, candidate)
	var m map[string]any
	if err := json.Unmarshal(msg, &m); err != nil {
		t.Fatal(err)
	}
	if m["type"] != "voice_ice" {
		t.Errorf("type = %v, want voice_ice", m["type"])
	}
	p := m["payload"].(map[string]any)
	if p["channel_id"] != float64(10) {
		t.Errorf("channel_id = %v, want 10", p["channel_id"])
	}
	c := p["candidate"].(map[string]any)
	if c["sdpMid"] != "0" {
		t.Errorf("candidate.sdpMid = %v, want 0", c["sdpMid"])
	}
}
