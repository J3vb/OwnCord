package app

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// telemetry.enabled on a build without the SDK must warn rather than silently
// doing nothing: the release and Docker builds carry no build tags, so an
// operator who sets the key there otherwise sees a configured exporter emit
// nothing and has no signal (SRE-M1).
func TestInitTelemetry_WarnsWhenEnabledWithoutSDK(t *testing.T) {
	var logs bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logs, nil))

	stop := initTelemetry(log, &config.Config{Telemetry: config.TelemetryConfig{Enabled: true, Exporter: "otlp"}})
	stop()

	warned := strings.Contains(logs.String(), "no OpenTelemetry SDK")
	if telemetry.SDKAvailable && warned {
		t.Errorf("otel build has the SDK but warned it does not: %s", logs.String())
	}
	if !telemetry.SDKAvailable && !warned {
		t.Errorf("default build must warn that telemetry.enabled is inert, got: %s", logs.String())
	}
}

// A disabled telemetry block is the compiled default and must stay quiet.
func TestInitTelemetry_QuietWhenDisabled(t *testing.T) {
	var logs bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logs, nil))

	stop := initTelemetry(log, &config.Config{})
	stop()

	if strings.Contains(logs.String(), "no OpenTelemetry SDK") {
		t.Errorf("telemetry disabled must not warn about the SDK: %s", logs.String())
	}
}
