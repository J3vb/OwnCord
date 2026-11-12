package livekitproc_test

import (
	"os"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/livekitproc"
)

// mustDo fails the test, naming the operation, when err is non-nil.
func mustDo(t testing.TB, operation string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", operation, err)
	}
}

// testVoiceConfig is a LiveKit config with the given credentials and the
// default local URL.
func testVoiceConfig(key, secret string) *config.VoiceConfig {
	return &config.VoiceConfig{LiveKitAPIKey: key, LiveKitAPISecret: secret, LiveKitURL: "ws://localhost:7880"}
}

// newProcess builds a LiveKit process over cfg with a default TLS config and
// a private data directory.
func newProcess(t *testing.T, cfg *config.VoiceConfig) *livekitproc.Process {
	t.Helper()
	return livekitproc.New(cfg, &config.TLSConfig{}, t.TempDir())
}

// testVoiceConfigAt is testVoiceConfig pointed at url, for health-check tests.
func testVoiceConfigAt(url string) *config.VoiceConfig {
	cfg := testVoiceConfig("key", "secret")
	cfg.LiveKitURL = url
	return cfg
}

// generatedConfig writes proc's livekit.yaml and returns its path and bytes.
func generatedConfig(t *testing.T, proc *livekitproc.Process) (path string, content []byte) {
	t.Helper()
	path, err := proc.GenerateConfigForTest()
	mustDo(t, "generateConfig", err)
	content, err = os.ReadFile(path)
	mustDo(t, "reading config file", err)
	return path, content
}
