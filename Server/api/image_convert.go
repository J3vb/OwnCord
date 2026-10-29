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
// preview is a JPEG made by the thumbnail route.
const (
	mimeHEIC = "image/heic"
	mimeHEIF = "image/heif"
	mimeTIFF = "image/tiff"
	// convertedPreviewMIME is what the thumbnail route answers for them.
	convertedPreviewMIME = "image/jpeg"

	// heicMaxNALs bounds the NAL units the HEIC check walks in a file.
	heicMaxNALs = 1 << 14
	// convertedHEICPeakBytes is the memory a HEIC conversion may take at its
	// peak, which is about heicPeakBytesPerPixel for each pixel: the decoded
	// picture, its RGBA copy and the rotated copy. It sets the largest HEIC
	// converted (about 22 megapixels of 8-bit colour, which covers a phone's
	// 12 MP photo; a 10-bit image gets half as many pixels).
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

// convertedSize is the upright size and the color model of the HEIC or TIFF
// in r, read by its own decoder: image.DecodeConfig would choose it by the
// major brand alone and buffer a TIFF whole. A HEIC is validated first, so
// nothing but a plain still reaches the HEIC decoder.
func convertedSize(r io.ReadSeeker, mimeType string) (cfg image.Config, err error) {
	src := withReadAt(r)
	if convertedFormat(mimeType) == "heic" {
		size, err := src.Seek(0, io.SeekEnd)
		if err != nil {
			return image.Config{}, fmt.Errorf("seeking: %w", err)
		}
		info, err := validateHEIC(src, size)
		if err != nil {
			return image.Config{}, err
		}
		if _, err := src.Seek(0, io.SeekStart); err != nil {
			return image.Config{}, fmt.Errorf("seeking: %w", err)
		}
		if cfg, err = heic.DecodeConfig(src); err != nil {
			return image.Config{}, fmt.Errorf("reading image size: %w", err)
		}
		if info.quarterTurn {
			cfg.Width, cfg.Height = cfg.Height, cfg.Width
		}
		return cfg, nil
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return image.Config{}, fmt.Errorf("seeking: %w", err)
	}
	if cfg, err = tiff.DecodeConfig(src); err != nil {
		return image.Config{}, fmt.Errorf("reading image size: %w", err)
	}
	if o := tiffOrientation(src); o >= 5 && o <= 8 {
		cfg.Width, cfg.Height = cfg.Height, cfg.Width
	}
	return cfg, nil
}

// makeConvertedPreview decodes the HEIC or TIFF in r (format as image.Decode
// names it) into an upright JPEG that fits thumbBox, never enlarged. The
// decode is bounded from the header: a TIFF by thumbMaxDecodeBytes, a HEIC by
// heicMaxPixels (less for a deeper color model), and a HEIC is decoded only
// when validateHEIC accepts its layout. A
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
	}
	cfg, err := convertedSize(src, mimeType)
	if err != nil {
		return nil, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, refuse("header does not parse")
	}
	// The pixel bound follows the color model: 4 bytes a pixel is the base, and
	// a 16-bit model gets half the pixels (the TIFF bound is thumbMaxDecodeBytes).
	perPixel := decodedBytesPerPixel(cfg.ColorModel)
	limit := int64(heicMaxPixels) * 4 / perPixel
	if format != "heic" {
		limit = thumbMaxDecodeBytes / perPixel
	}
	if int64(cfg.Width)*int64(cfg.Height) > limit {
		return nil, refuse("too large to decode")
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("%w: %w", errConvertRefused, err)
	}
	var img image.Image
	orientation := 1
	if format == "heic" {
		img, err = heic.Decode(src, heic.Options{AutoRotate: true, FrameSizeLimit: int(limit), Threads: 1})
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
