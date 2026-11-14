package api

import (
	"image"
	"io"

	"github.com/J3vb/OwnCord/Server/imgthumb"
)

// The thumbnail code lives in imgthumb, shared with link previews; these are the names the
// upload paths use, bound to the upload box.
const (
	thumbBox            = 800
	thumbMaxDecodeBytes = imgthumb.MaxDecodeBytes
	thumbJPEGQuality    = imgthumb.JPEGQuality
	mimeWebP            = imgthumb.MIMEWebP
)

var (
	thumbFormat          = imgthumb.Format
	thumbMIME            = imgthumb.MIME
	jpegHeader           = imgthumb.JPEGHeader
	decodedBytesPerPixel = imgthumb.DecodedBytesPerPixel
)

func orient(src *image.RGBA, o int) image.Image { return imgthumb.Orient(src, o) }

func thumbOrientation(r io.ReadSeeker, format string) (orientation int, ok bool) {
	return imgthumb.Orientation(r, format, thumbBox)
}

func makeThumbnail(r io.ReadSeeker, format string, orientation int) (thumb []byte, ok bool) {
	return imgthumb.Make(r, format, orientation, thumbBox)
}
