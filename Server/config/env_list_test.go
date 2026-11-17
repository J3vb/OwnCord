package config_test

import (
	"bytes"
	"log/slog"
	"slices"
	"strings"
	"testing"
)

func TestEnvEmptyListKeepsDefault(t *testing.T) {
	for _, value := range []string{"", "  ", " , ,"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("OWNCORD_SERVER_ADMIN_ALLOWED_CIDRS", value)

			var buf bytes.Buffer
			prev := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
			t.Cleanup(func() { slog.SetDefault(prev) })

			cfg := loadBody(t, "")
			if len(cfg.Server.AdminAllowedCIDRs) == 0 || slices.Contains(cfg.Server.AdminAllowedCIDRs, "") {
				t.Fatalf("admin_allowed_cidrs = %#v, want the default list", cfg.Server.AdminAllowedCIDRs)
			}
			if !strings.Contains(buf.String(), "ignoring empty list environment variable") {
				t.Errorf("missing empty-list warning, log: %s", buf.String())
			}
			if strings.Contains(buf.String(), "perimeter is disabled") {
				t.Errorf("perimeter reported disabled, log: %s", buf.String())
			}
		})
	}
}
