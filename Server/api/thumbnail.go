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
	_ "golang.org/x/image/webp"
)

const (
	thumbBox = 800
	// Caps decode memory, estimated from the header (thumbOrientation); 96 MiB fits a 24-megapixel photo at 4
	// bytes a pixel.
	thumbMaxDecodeBytes = 96 << 20
	thumbJPEGQuality    = 82
	// What decoding a WebP pixel may cost: lossless decodes to 4 bytes and its inverse transforms can copy
	// once more.
	webpBytesPerPixel = 8

	mimeWebP = "image/webp"
)

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

// thumbFormat is the decoder name of an original that is thumbnailed, or "" when passed through (GIFs keep
// their animation; the rest have no decoder). A WebP's thumbnail is a JPEG, or a PNG when transparent, as
// there is no WebP encoder (thumbMIME).
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

// thumbMIME is the media type of a thumbnail whose first bytes are head.
func thumbMIME(mimeType string, head []byte) string {
	if mimeType != mimeWebP {
		return mimeType
	}
	if bytes.HasPrefix(head, pngSignature) {
		return "image/png"
	}
	return "image/jpeg"
}

// webpAnimated reports whether the WebP declares an animation; the decoder reads only stills, so an
// animated one is passed through.
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

// thumbOrientation decides from the header alone whether the image is thumbnailed and returns its EXIF
// orientation. ok is false when the original is passed through: it fits, its header does not parse, or its
// decode would exceed thumbMaxDecodeBytes. Like imageDimensions, a decode error or non-positive size is
// never trusted.
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

// decodedBytesPerPixel bounds a pixel's decode cost: 8 bytes for any 16-bit model, 4 otherwise; a
// progressive JPEG costs three times that for its coefficient blocks.
func decodedBytesPerPixel(m color.Model) int64 {
	switch m {
	case color.RGBA64Model, color.NRGBA64Model, color.Gray16Model:
		return 8
	}
	return 4
}

// makeThumbnail decodes the image thumbOrientation accepted and scales it to fit thumbBox, upright; a WebP
// becomes a JPEG when every pixel is opaque, else a PNG. ok is false when it does not decode.
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

// jpegHeader reads a JPEG's EXIF Orientation (1-8, or 1) and whether its frame is progressive; a frame it
// cannot reach counts as progressive.
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

// endsSegmentWalk reports whether marker ends jpegHeader's walk (scan start, fill, stuffed zeros,
// restarts).
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

// orient turns src upright for an EXIF orientation: 2-4 mirror or turn in place, 5-8 also swap width and
// height.
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
