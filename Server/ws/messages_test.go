package ws

import (
	"encoding/json"
	"testing"
)

func TestBuildServerRestartMsg(t *testing.T) {
	msg := buildServerRestartMsg("update", 5)
	var env struct {
		Type    string `json:"type"`
		Payload struct {
			Reason       string `json:"reason"`
			DelaySeconds int    `json:"delay_seconds"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "server_restart" {
		t.Errorf("type = %q, want server_restart", env.Type)
	}
	if env.Payload.Reason != "update" {
		t.Errorf("reason = %q, want update", env.Payload.Reason)
	}
	if env.Payload.DelaySeconds != 5 {
		t.Errorf("delay_seconds = %d, want 5", env.Payload.DelaySeconds)
	}
}
