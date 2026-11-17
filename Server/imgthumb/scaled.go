package imgthumb

import (
	"bytes"
	"image"
	_ "image/gif" // registers the GIF decoder; a GIF is read as its first frame
	"image/jpeg"
	"image/png"
	"io"
	"math"

	_ "golang.org/x/image/bmp" // registers the BMP decoder
	xdraw "golang.org/x/image/draw"
)

// Scaled is an image re-encoded to fit a box.
type Scaled struct {
	Data          []byte
	MIME          string
	Width, Height int
}

// Fit decodes a raster image (JPEG, PNG, GIF, WebP or BMP, told apart by the bytes, not a
// declared type) and returns it upright, scaled down to fit box by box and never up, as a JPEG
// when every pixel is opaque and else a PNG. Metadata is dropped. It reports false for an image
// that does not decode, an animated WebP, or one whose decode would exceed MaxDecodeBytes by
// its header; nothing is allocated for a size that fails that bound.
func Fit(data []byte, box int) (Scaled, bool) {
	r := bytes.NewReader(data)
	cfg, format, err := image.DecodeConfig(r)
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || box <= 0 {
		return Scaled{}, false
	}
	orientation, perPixel := 1, DecodedBytesPerPixel(cfg.ColorModel)
	switch format {
	case "webp":
		if webpAnimated(r) {
			return Scaled{}, false
		}
		perPixel = webpBytesPerPixel
	case "jpeg":
		if _, err := r.Seek(0, io.SeekStart); err != nil {
			return Scaled{}, false
		}
		var progressive bool
		if orientation, progressive = JPEGHeader(r); progressive {
			perPixel *= 3
		}
	}
	if int64(cfg.Width)*int64(cfg.Height) > MaxDecodeBytes/perPixel {
		return Scaled{}, false
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return Scaled{}, false
	}
	src, _, err := image.Decode(r)
	if err != nil {
		return Scaled{}, false
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	scale := math.Min(1, math.Min(float64(box)/float64(w), float64(box)/float64(h)))
	dst := image.NewRGBA(image.Rect(0, 0, max(1, int(math.Round(float64(w)*scale))), max(1, int(math.Round(float64(h)*scale)))))
	xdraw.BiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Src, nil)
	opaque := dst.Opaque()
	out := Orient(dst, orientation)

	var buf bytes.Buffer
	mime := "image/png"
	if opaque {
		mime = "image/jpeg"
		err = jpeg.Encode(&buf, out, &jpeg.Options{Quality: JPEGQuality})
	} else {
		err = png.Encode(&buf, out)
	}
	if err != nil {
		return Scaled{}, false
	}
	return Scaled{Data: buf.Bytes(), MIME: mime, Width: out.Bounds().Dx(), Height: out.Bounds().Dy()}, true
}
