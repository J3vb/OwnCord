package api

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"io"
	"math"

	"github.com/gen2brain/h265/heic"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/tiff" // registers the TIFF decoder with image.Decode
)

// Formats a browser cannot show, whose original is kept as uploaded and whose
// preview is a JPEG made by the thumbnail route (WP 8.12).
const (
	mimeHEIC = "image/heic"
	mimeHEIF = "image/heif"
	mimeTIFF = "image/tiff"
	// convertedPreviewMIME is what the thumbnail route answers for them.
	convertedPreviewMIME = "image/jpeg"

	// heicMetaMaxBytes caps the meta box read to find a rotation property.
	heicMetaMaxBytes = 4 << 20
	// tiffMaxIFDEntries bounds the orientation scan of a TIFF's first IFD.
	tiffMaxIFDEntries = 4096
)

// errConvertRefused marks an image that is not converted: it does not parse,
// it is too large to decode within thumbMaxDecodeBytes, or its decoder gave up.
var errConvertRefused = errors.New("image not converted")

// convertedFormat is the image.Decode format name of a stored MIME type the
// server previews as a JPEG, or "" for any other type.
func convertedFormat(mimeType string) string {
	switch mimeType {
	case mimeHEIC, mimeHEIF:
		return "heic"
	case mimeTIFF:
		return "tiff"
	}
	return ""
}

// sniffISOBMFFImage names the still-image type of an ISO base media file from
// its ftyp box: any HEVC brand (heic, heix, ...) makes it a HEIC, and a
// mif1/msf1 major brand without one a plain HEIF. AVIF (avif/avis brands), MP4
// and QuickTime are none of these. It returns "" for anything else.
func sniffISOBMFFImage(header []byte) string {
	if len(header) < 16 || string(header[4:8]) != "ftyp" {
		return ""
	}
	end := int(binary.BigEndian.Uint32(header[:4]))
	if end < 16 || end > len(header) {
		end = len(header)
	}
	major := string(header[8:12])
	brands := []string{major}
	for i := 16; i+4 <= end; i += 4 { // 12..16 is the minor version
		brands = append(brands, string(header[i:i+4]))
	}
	heif, avif := false, false
	for i, b := range brands {
		switch b {
		case "heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs":
			return mimeHEIC
		case "avif", "avis":
			avif = true
		case "mif1", "msf1":
			heif = heif || i == 0
		}
	}
	if heif && !avif {
		return mimeHEIF
	}
	return ""
}

// sniffTIFF reports a TIFF (classic, either byte order) by its header.
func sniffTIFF(header []byte) bool {
	return bytes.HasPrefix(header, []byte("II*\x00")) || bytes.HasPrefix(header, []byte("MM\x00*"))
}

// convertedUprightSwap reports whether the image in r, stored as mimeType, is
// shown a quarter turn from how it is stored, so its upright width and height
// swap: a HEIC's irot of 90 or 270 degrees (iPhone portrait shots are stored
// landscape), or a TIFF's orientation 5-8, as the preview is made.
func convertedUprightSwap(r io.ReadSeeker, mimeType string) bool {
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return false
	}
	switch convertedFormat(mimeType) {
	case "heic":
		return heicQuarterTurn(r)
	case "tiff":
		o := tiffOrientation(r)
		return o >= 5 && o <= 8
	}
	return false
}

// isoBox is one box of an ISO base media file.
type isoBox struct {
	typ  string
	body []byte
}

// isoBoxes splits b into its boxes; a box that overruns b ends the list.
func isoBoxes(b []byte) []isoBox {
	var out []isoBox
	for len(b) >= 8 {
		size := uint64(binary.BigEndian.Uint32(b))
		hdr := uint64(8)
		if size == 1 {
			if len(b) < 16 {
				break
			}
			size, hdr = binary.BigEndian.Uint64(b[8:]), 16
		} else if size == 0 {
			size = uint64(len(b))
		}
		if size < hdr || size > uint64(len(b)) {
			break
		}
		out = append(out, isoBox{typ: string(b[4:8]), body: b[hdr:size]})
		b = b[size:]
	}
	return out
}

// heicQuarterTurn reports whether the primary image of the HEIC in r carries
// an irot property of 90 or 270 degrees. heic.DecodeConfig returns the stored
// size, before the rotation, and the package exposes nothing cheaper than a
// full decode, so the one property is read here. Anything it cannot follow
// counts as no rotation.
func heicQuarterTurn(r io.Reader) bool {
	var hdr [8]byte
	for range 64 {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return false
		}
		size := uint64(binary.BigEndian.Uint32(hdr[:4]))
		skip := uint64(8)
		if size == 1 {
			var large [8]byte
			if _, err := io.ReadFull(r, large[:]); err != nil {
				return false
			}
			size, skip = binary.BigEndian.Uint64(large[:]), 16
		}
		if size < skip {
			return false
		}
		payload := size - skip
		if string(hdr[4:]) != "meta" {
			if _, err := io.CopyN(io.Discard, r, int64(min(payload, math.MaxInt64))); err != nil {
				return false
			}
			continue
		}
		if payload > heicMetaMaxBytes {
			return false
		}
		meta := make([]byte, payload)
		if _, err := io.ReadFull(r, meta); err != nil {
			return false
		}
		return metaHasQuarterTurn(meta)
	}
	return false
}

// metaHasQuarterTurn looks up the properties of the primary item (pitm)
// through ipma, into the ipco list under iprp.
func metaHasQuarterTurn(meta []byte) bool {
	if len(meta) < 4 {
		return false
	}
	var primary uint32
	var havePrimary bool
	var props []isoBox
	var ipma []byte
	for _, b := range isoBoxes(meta[4:]) { // meta is a full box: version and flags first
		switch b.typ {
		case "pitm":
			if len(b.body) >= 6 && b.body[0] == 0 {
				primary, havePrimary = uint32(binary.BigEndian.Uint16(b.body[4:])), true
			} else if len(b.body) >= 8 && b.body[0] == 1 {
				primary, havePrimary = binary.BigEndian.Uint32(b.body[4:]), true
			}
		case "iprp":
			for _, c := range isoBoxes(b.body) {
				switch c.typ {
				case "ipco":
					props = isoBoxes(c.body)
				case "ipma":
					ipma = c.body
				}
			}
		}
	}
	if !havePrimary || len(ipma) < 8 {
		return false
	}
	version, wide := ipma[0], ipma[3]&1 == 1
	count := binary.BigEndian.Uint32(ipma[4:])
	p := ipma[8:]
	for range count {
		idSize := 2
		if version >= 1 {
			idSize = 4
		}
		if len(p) < idSize+1 {
			return false
		}
		id := uint32(binary.BigEndian.Uint16(p))
		if idSize == 4 {
			id = binary.BigEndian.Uint32(p)
		}
		n := int(p[idSize])
		p = p[idSize+1:]
		step := 1
		if wide {
			step = 2
		}
		if len(p) < n*step {
			return false
		}
		for i := range n {
			idx := int(p[i*step] & 0x7f)
			if wide {
				idx = int(binary.BigEndian.Uint16(p[i*step:]) & 0x7fff)
			}
			if id == primary && idx >= 1 && idx <= len(props) {
				if pr := props[idx-1]; pr.typ == "irot" && len(pr.body) >= 1 {
					return pr.body[0]&1 == 1
				}
			}
		}
		p = p[n*step:]
	}
	return false
}

// tiffOrientation reads the Orientation tag (1-8, or 1 when absent or
// unreadable) from the first IFD of the TIFF in r.
func tiffOrientation(r io.ReadSeeker) int {
	var head [8]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 1
	}
	var bo binary.ByteOrder
	switch string(head[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	if _, err := r.Seek(int64(bo.Uint32(head[4:])), io.SeekStart); err != nil {
		return 1
	}
	var cnt [2]byte
	if _, err := io.ReadFull(r, cnt[:]); err != nil {
		return 1
	}
	var entry [12]byte
	for range min(int(bo.Uint16(cnt[:])), tiffMaxIFDEntries) {
		if _, err := io.ReadFull(r, entry[:]); err != nil {
			return 1
		}
		if bo.Uint16(entry[:]) == 0x0112 {
			if o := int(bo.Uint16(entry[8:])); o >= 1 && o <= 8 {
				return o
			}
			return 1
		}
	}
	return 1
}

// makeConvertedPreview decodes the HEIC or TIFF in r (format as image.Decode
// names it) into an upright JPEG that fits thumbBox, never enlarged. The
// decode is bounded by thumbMaxDecodeBytes from the header, and a panic in a
// decoder fed hostile input is a failed conversion, not a crashed request.
func makeConvertedPreview(r io.ReadSeeker, format string) (jpg []byte, err error) {
	defer func() {
		if p := recover(); p != nil {
			jpg, err = nil, fmt.Errorf("%w: decoder panic", errConvertRefused)
		}
	}()
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("%w: %w", errConvertRefused, err)
	}
	cfg, got, err := image.DecodeConfig(r)
	if err != nil || got != format || cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, fmt.Errorf("%w: header does not parse", errConvertRefused)
	}
	perPixel := decodedBytesPerPixel(cfg.ColorModel)
	if int64(cfg.Width)*int64(cfg.Height) > thumbMaxDecodeBytes/perPixel {
		return nil, fmt.Errorf("%w: too large to decode", errConvertRefused)
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("%w: %w", errConvertRefused, err)
	}
	var src image.Image
	orientation := 1
	if format == "heic" {
		src, err = heic.Decode(r, heic.Options{AutoRotate: true, FrameSizeLimit: thumbMaxDecodeBytes / 4, Threads: 1})
	} else {
		orientation = tiffOrientation(r)
		if _, err := r.Seek(0, io.SeekStart); err != nil {
			return nil, fmt.Errorf("%w: %w", errConvertRefused, err)
		}
		src, _, err = image.Decode(r)
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errConvertRefused, err)
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	if w <= 0 || h <= 0 {
		return nil, fmt.Errorf("%w: empty image", errConvertRefused)
	}
	scale := math.Min(1, math.Min(float64(thumbBox)/float64(w), float64(thumbBox)/float64(h)))
	dst := image.NewRGBA(image.Rect(0, 0, max(1, int(math.Round(float64(w)*scale))), max(1, int(math.Round(float64(h)*scale)))))
	// JPEG has no alpha: lay the picture over white, not over black.
	draw.Draw(dst, dst.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	xdraw.BiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Over, nil)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, orient(dst, orientation), &jpeg.Options{Quality: thumbJPEGQuality}); err != nil {
		return nil, fmt.Errorf("%w: %w", errConvertRefused, err)
	}
	return buf.Bytes(), nil
}
