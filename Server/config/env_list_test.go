package config_test

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestEnvEmptyListOverridesDefault(t *testing.T) {
	for _, value := range []string{"", "  ", " , ,"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("OWNCORD_SERVER_ADMIN_ALLOWED_CIDRS", value)

			var buf bytes.Buffer
			prev := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
			t.Cleanup(func() { slog.SetDefault(prev) })

			cfg := loadBody(t, "")
			if len(cfg.Server.AdminAllowedCIDRs) != 0 {
				t.Fatalf("admin_allowed_cidrs = %#v, want empty", cfg.Server.AdminAllowedCIDRs)
			}
			if !strings.Contains(buf.String(), "perimeter is disabled") {
				t.Errorf("missing perimeter-disabled warning, log: %s", buf.String())
			}
		})
	}
}
