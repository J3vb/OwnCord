package imgthumb

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

func makePNG(t *testing.T, w, h int, alpha uint8) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for x := range w {
		for y := range h {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 7, A: alpha})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func decodeSize(t *testing.T, s Scaled) (image.Config, string) {
	t.Helper()
	cfg, format, err := image.DecodeConfig(bytes.NewReader(s.Data))
	if err != nil {
		t.Fatalf("result does not decode: %v", err)
	}
	return cfg, format
}

func TestFit_ScalesDownKeepingAspectAndNeverUp(t *testing.T) {
	got, ok := Fit(makePNG(t, 1600, 800, 255), 640)
	if !ok || got.Width != 640 || got.Height != 320 || got.MIME != "image/jpeg" {
		t.Fatalf("wide opaque = %+v, %v; want a 640x320 JPEG", got.MIME, ok)
	}
	if cfg, format := decodeSize(t, got); cfg.Width != 640 || format != "jpeg" {
		t.Errorf("encoded as %s %dx%d", format, cfg.Width, cfg.Height)
	}
	tall, ok := Fit(makePNG(t, 300, 1500, 255), 640)
	if !ok || tall.Height != 640 || tall.Width != 128 {
		t.Errorf("tall = %dx%d, want 128x640", tall.Width, tall.Height)
	}
	small, ok := Fit(makePNG(t, 100, 50, 255), 640)
	if !ok || small.Width != 100 || small.Height != 50 {
		t.Errorf("small = %dx%d, want it left alone", small.Width, small.Height)
	}
}

func TestFit_TransparencyStaysPNG(t *testing.T) {
	got, ok := Fit(makePNG(t, 900, 300, 128), 640)
	if !ok || got.MIME != "image/png" {
		t.Fatalf("translucent = %v, %v; want PNG", got.MIME, ok)
	}
	if _, format := decodeSize(t, got); format != "png" {
		t.Errorf("format = %s", format)
	}
}

func TestFit_ReadsJPEGAndFirstGIFFrame(t *testing.T) {
	var jb bytes.Buffer
	if err := jpeg.Encode(&jb, image.NewRGBA(image.Rect(0, 0, 800, 600)), nil); err != nil {
		t.Fatal(err)
	}
	if got, ok := Fit(jb.Bytes(), 640); !ok || got.Width != 640 || got.Height != 480 {
		t.Errorf("jpeg = %dx%d, %v", got.Width, got.Height, ok)
	}
	pal := image.NewPaletted(image.Rect(0, 0, 700, 100), color.Palette{color.Black, color.White})
	var gb bytes.Buffer
	if err := gif.EncodeAll(&gb, &gif.GIF{Image: []*image.Paletted{pal, pal}, Delay: []int{1, 1}}); err != nil {
		t.Fatal(err)
	}
	if got, ok := Fit(gb.Bytes(), 640); !ok || got.Width != 640 {
		t.Errorf("gif = %dx%d, %v", got.Width, got.Height, ok)
	}
}

func TestFit_RefusesWhatItCannotOrShouldNotDecode(t *testing.T) {
	if _, ok := Fit([]byte("not an image"), 640); ok {
		t.Error("garbage was accepted")
	}
	if _, ok := Fit(nil, 640); ok {
		t.Error("empty input was accepted")
	}
	if _, ok := Fit(makePNG(t, 10, 10, 255), 0); ok {
		t.Error("a zero box was accepted")
	}
	// A PNG whose header claims a size past the decode budget is refused before any pixel is allocated.
	huge := makePNG(t, 8, 8, 255)
	copy(huge[16:20], []byte{0x00, 0x00, 0x7f, 0xff}) // width 32767
	copy(huge[20:24], []byte{0x00, 0x00, 0x7f, 0xff}) // height 32767
	if _, ok := Fit(huge, 640); ok {
		t.Error("an image over the decode budget was decoded")
	}
}

// FuzzFit throws untrusted bytes at the fetched-image path. Fit must return
// without a panic and, when it accepts, a result that fits the box.
func FuzzFit(f *testing.F) {
	for _, s := range [][]byte{nil, {0xFF, 0xD8}, []byte("GIF89a"), []byte("\x89PNG\r\n\x1a\n")} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		if s, ok := Fit(data, 64); ok {
			if cfg, _ := decodeSize(t, s); cfg.Width > 64 || cfg.Height > 64 {
				t.Fatalf("Fit result %dx%d exceeds the box", cfg.Width, cfg.Height)
			}
		}
	})
}
