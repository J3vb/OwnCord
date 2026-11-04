package api

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"math"

	xdraw "golang.org/x/image/draw"
	// Registers the WebP decoder with image.Decode and image.DecodeConfig.
	_ "golang.org/x/image/webp"
)

const (
	// thumbBox bounds both sides of a thumbnail. The client shows an inline
	// image in at most 400×350 CSS px, so 800 stays sharp at 2× scaling.
	thumbBox = 800
	// thumbMaxDecodeBytes caps the memory a decode may take, estimated from
	// the header (thumbOrientation): an image declaring more is passed
	// through without a decode. 96 MiB still fits a 24-megapixel photo at
	// 4 bytes a pixel and refuses a 4500x4500 16-bit image.
	thumbMaxDecodeBytes = 96 << 20
	thumbJPEGQuality    = 82
	// webpBytesPerPixel is what decoding a WebP pixel may cost: a lossless
	// frame is decoded into 4 bytes a pixel and its inverse transforms can
	// copy that once more, and a lossy frame with alpha stays well under it.
	webpBytesPerPixel = 8

	mimeWebP = "image/webp"
)

// pngSignature opens every PNG.
var pngSignature = []byte("\x89PNG\r\n\x1a\n")

// thumbFormat is the decoder name of an original of mimeType that is
// thumbnailed, or "" when it is passed through as is: GIFs keep their
// animation, and the rest have no decoder here. A JPEG or PNG thumbnail keeps
// its original's format; a WebP's is a JPEG, or a PNG when it is transparent
// (there is no WebP encoder here), see thumbMIME.
func thumbFormat(mimeType string) string {
	switch mimeType {
	case "image/jpeg":
		return "jpeg"
	case "image/png":
		return "png"
	case mimeWebP:
		return "webp"
	}
	return ""
}

// thumbMIME is the media type of a thumbnail whose first bytes are head, made
// for an original of mimeType.
func thumbMIME(mimeType string, head []byte) string {
	if mimeType != mimeWebP {
		return mimeType
	}
	if bytes.HasPrefix(head, pngSignature) {
		return "image/png"
	}
	return "image/jpeg"
}

// webpAnimated reports whether the WebP in r declares an animation in its
// extended header. The decoder here reads only still images, so an animated
// WebP is passed through and keeps its frames.
func webpAnimated(r io.ReadSeeker) bool {
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return true
	}
	var hdr [21]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return false
	}
	const animationBit = 1 << 1
	return string(hdr[12:16]) == "VP8X" && hdr[20]&animationBit != 0
}

// thumbOrientation decides from the header alone whether the image in r is
// thumbnailed, and returns its EXIF orientation when it is. ok is false when
// the original should be passed through instead: it already fits, its header
// does not parse, or its decode would take more than thumbMaxDecodeBytes.
//
// Like imageDimensions (emoji_handler.go), a decode error or a non-positive
// size is never trusted, and nothing the declared size would allocate is
// decoded past the cap.
func thumbOrientation(r io.ReadSeeker, format string) (orientation int, ok bool) {
	cfg, got, err := image.DecodeConfig(r)
	if err != nil || got != format || cfg.Width <= 0 || cfg.Height <= 0 ||
		(cfg.Width <= thumbBox && cfg.Height <= thumbBox) {
		return 0, false
	}
	orientation, perPixel := 1, decodedBytesPerPixel(cfg.ColorModel)
	if format == "webp" {
		if webpAnimated(r) {
			return 0, false
		}
		perPixel = webpBytesPerPixel
	}
	if format == "jpeg" {
		if _, err := r.Seek(0, io.SeekStart); err != nil {
			return 0, false
		}
		var progressive bool
		if orientation, progressive = jpegHeader(r); progressive {
			perPixel *= 3
		}
	}
	if int64(cfg.Width)*int64(cfg.Height) > thumbMaxDecodeBytes/perPixel {
		return 0, false
	}
	return orientation, true
}

// decodedBytesPerPixel bounds what decoding a pixel of model m costs: 8 bytes
// for any 16-bit model (the largest, RGBA64, takes 8), 4 for the rest. A
// progressive JPEG costs three times that, for the coefficient block it also
// holds per component.
func decodedBytesPerPixel(m color.Model) int64 {
	switch m {
	case color.RGBA64Model, color.NRGBA64Model, color.Gray16Model:
		return 8
	}
	return 4
}

// makeThumbnail decodes the image in r, which thumbOrientation accepted, and
// scales it to fit thumbBox, upright by orientation: in the same format for a
// JPEG or PNG, and for a WebP as a JPEG when every pixel is opaque, else as a
// PNG. ok is false when it does not decode.
func makeThumbnail(r io.ReadSeeker, format string, orientation int) (thumb []byte, ok bool) {
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return nil, false
	}
	src, _, err := image.Decode(r)
	if err != nil {
		return nil, false
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	scale := math.Min(float64(thumbBox)/float64(w), float64(thumbBox)/float64(h))
	dst := image.NewRGBA(image.Rect(0, 0, max(1, int(math.Round(float64(w)*scale))), max(1, int(math.Round(float64(h)*scale)))))
	xdraw.BiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Src, nil)
	out := orient(dst, orientation)

	var buf bytes.Buffer
	if format == "jpeg" || (format == "webp" && dst.Opaque()) {
		err = jpeg.Encode(&buf, out, &jpeg.Options{Quality: thumbJPEGQuality})
	} else {
		err = png.Encode(&buf, out)
	}
	if err != nil {
		return nil, false
	}
	return buf.Bytes(), true
}

// jpegHeader reads a JPEG's EXIF Orientation (1–8, or 1 when there is none
// or it does not parse) and whether its frame is progressive, from the
// segments before the image data. A frame it does not reach, past a segment
// it cannot walk, counts as progressive.
func jpegHeader(r io.Reader) (orientation int, progressive bool) {
	orientation, progressive = 1, true
	br := bufio.NewReader(r)
	var hdr [4]byte
	if _, err := io.ReadFull(br, hdr[:2]); err != nil || hdr[0] != 0xFF || hdr[1] != 0xD8 {
		return orientation, progressive
	}
	sawFrame, sawExif := false, false
	for range 64 {
		if _, err := io.ReadFull(br, hdr[:]); err != nil || hdr[0] != 0xFF {
			return orientation, progressive
		}
		marker, n := hdr[1], int(binary.BigEndian.Uint16(hdr[2:]))-2
		if endsSegmentWalk(marker) || n < 0 {
			return orientation, progressive
		}
		switch {
		case !sawFrame && (marker == 0xC0 || marker == 0xC1 || marker == 0xC2):
			sawFrame, progressive = true, marker == 0xC2
		case !sawExif && marker == 0xE1:
			seg := make([]byte, n)
			if _, err := io.ReadFull(br, seg); err != nil {
				return orientation, progressive
			}
			if tiff, found := bytes.CutPrefix(seg, []byte("Exif\x00\x00")); found {
				orientation, sawExif = exifOrientation(tiff), true
			}
			continue
		}
		if _, err := br.Discard(n); err != nil {
			return orientation, progressive
		}
	}
	return orientation, progressive
}

// endsSegmentWalk reports whether marker ends jpegHeader's walk: start of
// scan, fill bytes, stuffed zeros and restart markers are read differently
// from a segment by the decoder.
func endsSegmentWalk(marker byte) bool {
	return marker == 0xDA || marker == 0xFF || marker == 0x00 || (marker >= 0xD0 && marker <= 0xD7)
}

func exifOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	ifd := uint64(bo.Uint32(tiff[4:]))
	if ifd+2 > uint64(len(tiff)) {
		return 1
	}
	entries := tiff[ifd+2:]
	for range bo.Uint16(tiff[ifd:]) {
		if len(entries) < 12 {
			return 1
		}
		if bo.Uint16(entries) == 0x0112 {
			if o := int(bo.Uint16(entries[8:])); o >= 1 && o <= 8 {
				return o
			}
			return 1
		}
		entries = entries[12:]
	}
	return 1
}

// orient turns src upright for an EXIF orientation: 2–4 mirror or turn it
// in place, 5–8 also swap its width and height.
func orient(src *image.RGBA, o int) image.Image {
	if o < 2 || o > 8 {
		return src
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := range dh {
		for x := range dw {
			var sx, sy int
			switch o {
			case 2:
				sx, sy = w-1-x, y
			case 3:
				sx, sy = w-1-x, h-1-y
			case 4:
				sx, sy = x, h-1-y
			case 5:
				sx, sy = y, x
			case 6:
				sx, sy = y, h-1-x
			case 7:
				sx, sy = w-1-y, h-1-x
			case 8:
				sx, sy = w-1-y, x
			}
			dst.SetRGBA(x, y, src.RGBAAt(sx, sy))
		}
	}
	return dst
}
