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
	"golang.org/x/image/tiff"
)

// Formats a browser cannot show, whose original is kept as uploaded and whose
// preview is a JPEG made by the thumbnail route (WP 8.12).
const (
	mimeHEIC = "image/heic"
	mimeHEIF = "image/heif"
	mimeTIFF = "image/tiff"
	// convertedPreviewMIME is what the thumbnail route answers for them.
	convertedPreviewMIME = "image/jpeg"

	// heicMetaMaxBytes caps the meta box read to find its items and properties.
	heicMetaMaxBytes = 4 << 20
	// heicMaxItems and heicMaxNALs bound what the item check walks.
	heicMaxItems = 4096
	heicMaxNALs  = 1 << 16
	// convertedHEICPeakBytes is the memory a HEIC conversion may take at its
	// peak, which is about heicPeakBytesPerPixel for each pixel: the decoded
	// picture, its RGBA copy and the rotated copy. It sets the largest HEIC
	// converted (about 22 megapixels, which covers a phone's 12 MP photo).
	convertedHEICPeakBytes = 256 << 20
	heicPeakBytesPerPixel  = 12
	heicMaxPixels          = convertedHEICPeakBytes / heicPeakBytesPerPixel
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
		o := tiffOrientation(withReadAt(r))
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

// readerAt is what the decoders want: a seekable reader that also reads at an
// offset, so a decode of a large file does not buffer all of it.
type readerAt interface {
	io.ReadSeeker
	io.ReaderAt
}

// seekReadAt gives a reader that only seeks a ReadAt, for one reader at a time.
type seekReadAt struct{ io.ReadSeeker }

func (s seekReadAt) ReadAt(p []byte, off int64) (int, error) {
	if _, err := s.Seek(off, io.SeekStart); err != nil {
		return 0, fmt.Errorf("seeking: %w", err)
	}
	n, err := io.ReadFull(s, p)
	if errors.Is(err, io.ErrUnexpectedEOF) {
		err = io.EOF
	}
	return n, err
}

func withReadAt(r io.ReadSeeker) readerAt {
	if ra, ok := r.(readerAt); ok {
		return ra
	}
	return seekReadAt{r}
}

// convertedConfig is the stored size of the HEIC or TIFF in r, read by its
// own decoder: image.DecodeConfig would choose it by the major brand alone and
// buffer a TIFF whole.
func convertedConfig(r io.ReadSeeker, mimeType string) (image.Config, error) {
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return image.Config{}, fmt.Errorf("seeking: %w", err)
	}
	var cfg image.Config
	var err error
	if convertedFormat(mimeType) == "heic" {
		cfg, err = heic.DecodeConfig(withReadAt(r))
	} else {
		cfg, err = tiff.DecodeConfig(withReadAt(r))
	}
	if err != nil {
		return image.Config{}, fmt.Errorf("reading image size: %w", err)
	}
	return cfg, nil
}

// tiffIFD0 reads the first IFD of the TIFF in r as tag to the first value
// field's low 16 bits, and whether the header and directory parsed.
func tiffIFD0(r io.ReaderAt) (tags map[uint16]uint16, ok bool) {
	var head [8]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return nil, false
	}
	var bo binary.ByteOrder
	switch string(head[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return nil, false
	}
	ifd := int64(bo.Uint32(head[4:]))
	var cnt [2]byte
	if _, err := r.ReadAt(cnt[:], ifd); err != nil {
		return nil, false
	}
	n := min(int(bo.Uint16(cnt[:])), tiffMaxIFDEntries)
	buf := make([]byte, n*12)
	if _, err := r.ReadAt(buf, ifd+2); err != nil {
		return nil, false
	}
	tags = make(map[uint16]uint16, n)
	for i := range n {
		e := buf[i*12:]
		tags[bo.Uint16(e)] = bo.Uint16(e[8:])
	}
	return tags, true
}

// tiffOrientation reads the Orientation tag (1-8, or 1 when absent or
// unreadable) from the first IFD of the TIFF in r.
func tiffOrientation(r io.ReaderAt) int {
	tags, ok := tiffIFD0(r)
	if o := int(tags[0x0112]); ok && o >= 1 && o <= 8 {
		return o
	}
	return 1
}

// isCameraRAW reports whether the TIFF-structured file in r is a camera RAW
// (DNG, NEF, CR2, ARW and the like) rather than a plain TIFF: those are not
// pictures a preview can be made of, so they stay a download. It looks for
// the DNGVersion tag, the Canon CR2 marker, and old-style JPEG compression
// in the first IFD, which the TIFF decoder does not read either.
func isCameraRAW(r io.ReaderAt) bool {
	var mark [2]byte
	if _, err := r.ReadAt(mark[:], 8); err == nil && string(mark[:]) == "CR" {
		return true
	}
	tags, ok := tiffIFD0(r)
	if !ok {
		return false
	}
	if _, dng := tags[0xC612]; dng {
		return true
	}
	c := tags[0x0103]
	return c == 6 || c == 7
}

// makeConvertedPreview decodes the HEIC or TIFF in r (format as image.Decode
// names it) into an upright JPEG that fits thumbBox, never enlarged. The
// decode is bounded from the header: a TIFF by thumbMaxDecodeBytes, a HEIC by
// heicMaxPixels, and a HEIC is decoded only when it is one still picture. A
// panic in a decoder fed hostile input is a failed conversion, not a crashed
// request.
func makeConvertedPreview(r io.ReadSeeker, format string) (jpg []byte, err error) {
	defer func() {
		if p := recover(); p != nil {
			jpg, err = nil, fmt.Errorf("%w: decoder panic", errConvertRefused)
		}
	}()
	src := withReadAt(r)
	mimeType := mimeTIFF
	if format == "heic" {
		mimeType = mimeHEIC
		if err := checkHEICStill(src); err != nil {
			return nil, err
		}
	}
	cfg, err := convertedConfig(src, mimeType)
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, fmt.Errorf("%w: header does not parse", errConvertRefused)
	}
	pixels := int64(cfg.Width) * int64(cfg.Height)
	limit := int64(heicMaxPixels)
	if format != "heic" {
		limit = thumbMaxDecodeBytes / decodedBytesPerPixel(cfg.ColorModel)
	}
	if pixels > limit {
		return nil, fmt.Errorf("%w: too large to decode", errConvertRefused)
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("%w: %w", errConvertRefused, err)
	}
	var img image.Image
	orientation := 1
	if format == "heic" {
		img, err = heic.Decode(src, heic.Options{AutoRotate: true, FrameSizeLimit: heicMaxPixels, Threads: 1})
	} else {
		orientation = tiffOrientation(src)
		img, err = tiff.Decode(src)
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errConvertRefused, err)
	}
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	if w <= 0 || h <= 0 {
		return nil, fmt.Errorf("%w: empty image", errConvertRefused)
	}
	scale := math.Min(1, math.Min(float64(thumbBox)/float64(w), float64(thumbBox)/float64(h)))
	dst := image.NewRGBA(image.Rect(0, 0, max(1, int(math.Round(float64(w)*scale))), max(1, int(math.Round(float64(h)*scale)))))
	// JPEG has no alpha: lay the picture over white, not over black.
	draw.Draw(dst, dst.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	xdraw.BiLinear.Scale(dst, dst.Bounds(), img, img.Bounds(), xdraw.Over, nil)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, orient(dst, orientation), &jpeg.Options{Quality: thumbJPEGQuality}); err != nil {
		return nil, fmt.Errorf("%w: %w", errConvertRefused, err)
	}
	return buf.Bytes(), nil
}
