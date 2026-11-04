package livekitproc

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
)

// RED requires the race detector: IsRunning and Stop read exec.Cmd.Process
// under p.mu, so runLoop must publish that write inside the same critical
// section (Start under p.mu, Wait outside) or the accesses race.
func TestProcess_IsRunningWhileStarting_NoRaceOnCmdProcess(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-livekit.sh")
	content := "#!/bin/sh\nsleep 1\n"
	if runtime.GOOS == "windows" {
		script = filepath.Join(dir, "fake-livekit.bat")
		content = "@ping -n 2 127.0.0.1 > nul\r\n"
	}
	if err := os.WriteFile(script, []byte(content), 0o700); err != nil {
		t.Fatalf("write fake binary: %v", err)
	}

	p := New(&config.VoiceConfig{
		LiveKitAPIKey:    "harvest-key",
		LiveKitAPISecret: "harvest-secret",
		LiveKitURL:       "ws://127.0.0.1:9",
	}, &config.TLSConfig{}, dir)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		p.runLoop(ctx, filepath.Join(dir, "livekit.yaml"), script)
	}()

	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		p.IsRunning()
	}
	cancel()
	<-done
}
