package api

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
	"time"
)

// fuzzWebPVP8L builds a minimal RIFF/WEBP/VP8L container of the given size.
func fuzzWebPVP8L(w, h int) []byte {
	buf := make([]byte, 30)
	copy(buf[0:4], "RIFF")
	binary.LittleEndian.PutUint32(buf[4:8], uint32(len(buf)-8))
	copy(buf[8:12], "WEBP")
	copy(buf[12:16], "VP8L")
	binary.LittleEndian.PutUint32(buf[16:20], uint32(len(buf)-20))
	buf[20] = 0x2F
	bits := uint32(w-1) | uint32(h-1)<<14
	binary.LittleEndian.PutUint32(buf[21:25], bits)
	return buf
}

// fuzzWebPVP8 builds a minimal RIFF/WEBP/VP8 (lossy) container.
func fuzzWebPVP8(w, h int) []byte {
	buf := make([]byte, 30)
	copy(buf[0:4], "RIFF")
	copy(buf[8:12], "WEBP")
	copy(buf[12:16], "VP8 ")
	buf[23], buf[24], buf[25] = 0x9d, 0x01, 0x2a
	binary.LittleEndian.PutUint16(buf[26:28], uint16(w)&0x3FFF)
	binary.LittleEndian.PutUint16(buf[28:30], uint16(h)&0x3FFF)
	return buf
}

// fuzzWebPVP8X builds a minimal RIFF/WEBP/VP8X (extended) container.
func fuzzWebPVP8X(w, h int) []byte {
	buf := make([]byte, 30)
	copy(buf[0:4], "RIFF")
	copy(buf[8:12], "WEBP")
	copy(buf[12:16], "VP8X")
	w1, h1 := uint32(w-1), uint32(h-1)
	buf[24], buf[25], buf[26] = byte(w1), byte(w1>>8), byte(w1>>16)
	buf[27], buf[28], buf[29] = byte(h1), byte(h1>>8), byte(h1>>16)
	return buf
}

func fuzzPNGBytes(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func fuzzGIFBytes(w, h int) []byte {
	img := image.NewPaletted(image.Rect(0, 0, w, h), color.Palette{color.Black, color.White})
	var buf bytes.Buffer
	_ = gif.Encode(&buf, img, nil)
	return buf.Bytes()
}

func fuzzJPEGBytes(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	return buf.Bytes()
}

// FuzzImageDimensions is the prime crash target: hand-rolled and stdlib
// header parsing over completely untrusted bytes, exactly what a malicious
// emoji/avatar upload delivers. Every corpus entry is run through all four
// supported mime types (not just the one it happens to be valid for) so a
// truncated PNG is also thrown at the JPEG/GIF/WebP paths and vice versa.
//
// The only allowed outcomes are: an error, or a (width, height) that is
// strictly positive. Anything else -- a panic, a hang, or a non-positive
// dimension slipping past as "success" -- is a bug: the caller in
// emoji_handler.go trusts a non-error result enough to compare it against
// maxEmojiDimension without re-validating its sign.
func FuzzImageDimensions(f *testing.F) {
	seeds := [][]byte{
		nil,
		{},
		{0},
		{0, 0, 0, 0},
		[]byte("RIFF"),
		[]byte("RIFFxxxxWEBP"),
		[]byte("RIFFxxxxWEBPVP8 "),
		[]byte("RIFFxxxxWEBPVP8L"),
		[]byte("RIFFxxxxWEBPVP8X"),
		[]byte("RIFFxxxxWEBPXXXX"),
		fuzzPNGBytes(1, 1),
		fuzzPNGBytes(128, 128),
		fuzzGIFBytes(1, 1),
		fuzzGIFBytes(128, 128),
		fuzzJPEGBytes(1, 1),
		fuzzJPEGBytes(128, 128),
		fuzzWebPVP8(100, 80),
		fuzzWebPVP8(16383, 16383), // max 14-bit dimension
		fuzzWebPVP8L(100, 80),
		fuzzWebPVP8L(16384, 16384), // max 14-bit+1 dimension
		fuzzWebPVP8X(100, 80),
		fuzzWebPVP8X(16777216, 16777216), // max 24-bit+1 dimension
	}
	// Truncate every seed at each prefix length up to 32 bytes (where every
	// format's fixed header lives) and then more coarsely beyond that: the
	// classic "header parser unchecked slice index" crasher lives in exactly
	// these cuts, but walking every single offset of a 128x128 PNG bloats the
	// corpus enough to stall the mutation phase for no extra coverage.
	for _, s := range seeds {
		f.Add(append([]byte(nil), s...))
		for cut := 0; cut < len(s) && cut <= 32; cut++ {
			f.Add(append([]byte(nil), s[:cut]...))
		}
		for cut := 40; cut < len(s); cut += 8 {
			f.Add(append([]byte(nil), s[:cut]...))
		}
	}

	mimeTypes := []string{"image/png", "image/jpeg", "image/gif", "image/webp"}

	f.Fuzz(func(t *testing.T, raw []byte) {
		done := make(chan struct{})
		go func() {
			defer close(done)
			for _, mt := range mimeTypes {
				w, h, err := imageDimensions(raw, mt)
				if err == nil && (w <= 0 || h <= 0) {
					t.Errorf("imageDimensions(%d bytes, %s) returned non-positive size %dx%d with no error", len(raw), mt, w, h)
				}
			}
			w, h, err := webpDimensions(raw)
			if err == nil && (w <= 0 || h <= 0) {
				t.Errorf("webpDimensions(%d bytes) returned non-positive size %dx%d with no error", len(raw), w, h)
			}
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("imageDimensions/webpDimensions hung on %d-byte input: %x", len(raw), raw)
		}
	})
}
