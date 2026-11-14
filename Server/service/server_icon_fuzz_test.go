package service

import (
	"bytes"
	"image/png"
	"testing"
)

// FuzzValidateServerIcon checks that ValidateServerIcon never panics on hostile bytes and that anything it
// accepts really is a square PNG inside the size limits.
func FuzzValidateServerIcon(f *testing.F) {
	f.Add(iconPNG(f, 64, 64, 1))
	f.Add(iconPNG(f, 32, 32, 2))
	f.Add(iconPNG(f, 64, 48, 3))
	f.Add([]byte("\x89PNG\r\n\x1a\n"))
	f.Add([]byte{})
	f.Add(bytes.Repeat([]byte{0xff}, 1000))

	f.Fuzz(func(t *testing.T, data []byte) {
		if err := ValidateServerIcon(data); err != nil {
			return
		}
		cfg, err := png.DecodeConfig(bytes.NewReader(data))
		if err != nil {
			t.Fatalf("accepted bytes that do not decode: %v", err)
		}
		if cfg.Width != cfg.Height || cfg.Width < ServerIconMinPx || cfg.Width > ServerIconMaxPx {
			t.Fatalf("accepted a %dx%d icon", cfg.Width, cfg.Height)
		}
		if len(data) > ServerIconMaxBytes {
			t.Fatalf("accepted %d bytes", len(data))
		}
	})
}
