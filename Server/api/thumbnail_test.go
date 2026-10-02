package api

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

// TestOrient_EveryEXIFOrientation checks where each EXIF orientation puts the
// stored image's first pixel, and that 5–8 swap the sides (EXIF 2.32, 4.6.4).
func TestOrient_EveryEXIFOrientation(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 3, 2))
	marker := color.RGBA{R: 255, A: 255}
	src.SetRGBA(0, 0, marker)
	for o, want := range map[int]image.Point{
		1: {0, 0}, 2: {2, 0}, 3: {2, 1}, 4: {0, 1},
		5: {0, 0}, 6: {1, 0}, 7: {1, 2}, 8: {0, 2},
	} {
		out := orient(src, o)
		if wantW := map[bool]int{true: 2, false: 3}[o >= 5]; out.Bounds().Dx() != wantW {
			t.Errorf("orientation %d: width %d, want %d", o, out.Bounds().Dx(), wantW)
		}
		if out.At(want.X, want.Y) != marker {
			t.Errorf("orientation %d: the first pixel is not at %v", o, want)
		}
	}
}

func fuzzThumbSeed(format string, w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if format == "jpeg" {
		_ = jpeg.Encode(&buf, img, nil)
	} else {
		_ = png.Encode(&buf, img)
	}
	return buf.Bytes()
}

// FuzzMakeThumbnail throws untrusted bytes at the thumbnail path the way an
// uploaded "image" reaches it. The only allowed outcomes are a pass-through,
// or a thumbnail in the same format that fits thumbBox; a panic or a hang is a
// bug. jpegHeader must keep the orientation within 1–8 whatever it reads.
func FuzzMakeThumbnail(f *testing.F) {
	for _, s := range [][]byte{
		nil,
		{0xFF, 0xD8},
		{0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x02},
		append([]byte{0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x16}, "Exif\x00\x00MM\x00\x2A\x00\x00\x00\x08\x00\x01\x01\x12"...),
		fuzzThumbSeed("jpeg", 900, 10),
		fuzzThumbSeed("png", 10, 900),
		fuzzThumbSeed("png", 8, 8),
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		if o, _ := jpegHeader(bytes.NewReader(data)); o < 1 || o > 8 {
			t.Fatalf("jpegHeader orientation = %d", o)
		}
		for _, format := range []string{"jpeg", "png"} {
			r := bytes.NewReader(data)
			orientation, ok := thumbOrientation(r, format)
			if !ok {
				continue
			}
			if orientation < 1 || orientation > 8 {
				t.Fatalf("%s orientation = %d", format, orientation)
			}
			thumb, ok := makeThumbnail(r, format, orientation)
			if !ok {
				continue
			}
			cfg, got, err := image.DecodeConfig(bytes.NewReader(thumb))
			if err != nil || got != format || cfg.Width > thumbBox || cfg.Height > thumbBox || cfg.Width < 1 || cfg.Height < 1 {
				t.Fatalf("%s thumbnail = %dx%d %s (%v)", format, cfg.Width, cfg.Height, got, err)
			}
		}
	})
}
