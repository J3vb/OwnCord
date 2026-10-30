package api

import (
	"fmt"
	"io"
	"net/http"

	"github.com/J3vb/OwnCord/Server/httperr"
)

// imageLimits is what readProfileImage holds an upload to: the byte cap, the
// largest width and height, and the noun its refusals use.
type imageLimits struct {
	Label    string // "avatar" or "banner"
	MaxBytes int64
	MaxW     int
	MaxH     int
	// AllowGIF admits image/gif next to PNG, JPEG and WebP. The
	// client shows an animated picture as its first frame until hovered, so
	// only the surfaces that do that accept one.
	AllowGIF bool
}

var avatarImageLimits = imageLimits{Label: "avatar", MaxBytes: maxAvatarFileBytes, MaxW: maxAvatarDimension, MaxH: maxAvatarDimension, AllowGIF: true}

// groupIconImageLimits are the group DM icon limits: an avatar's pixels, but
// still-only and the pre-8.7 byte cap.
var groupIconImageLimits = imageLimits{Label: "avatar", MaxBytes: maxGroupIconFileBytes, MaxW: maxAvatarDimension, MaxH: maxAvatarDimension}

var bannerImageLimits = imageLimits{Label: "banner", MaxBytes: maxBannerFileBytes, MaxW: maxBannerWidth, MaxH: maxBannerHeight, AllowGIF: true}

func (lim imageLimits) allows(mimeType string) bool {
	if lim.AllowGIF && mimeType == "image/gif" {
		return true
	}
	return allowedAvatarMIME[mimeType]
}

func (lim imageLimits) typeRefusal() string {
	if lim.AllowGIF {
		return lim.Label + " must be a PNG, JPEG, WebP or GIF image"
	}
	return lim.Label + " must be a PNG, JPEG or WebP image"
}

// readProfileImage is the bytes stage of the avatar, group icon and banner
// uploads: read the uploaded file under lim's cap, sniff its type and measure
// it. It writes its own 400 and reports ok=false when the upload is not
// acceptable, so the caller only has to return. Deliberately not shared with
// the emoji route: the two carry different caps and a different allowed MIME
// set.
func readProfileImage(w http.ResponseWriter, file io.Reader, lim imageLimits) (raw []byte, mimeType string, width, height int, ok bool) {
	// Read one byte past the cap so "exactly at the limit" passes and "one
	// byte over" is caught, without buffering an unbounded body.
	raw, err := io.ReadAll(io.LimitReader(file, lim.MaxBytes+1))
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "failed to read uploaded file")
		return nil, "", 0, 0, false
	}
	if int64(len(raw)) > lim.MaxBytes {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, fmt.Sprintf("%s must be at most %d KB", lim.Label, lim.MaxBytes>>10))
		return nil, "", 0, 0, false
	}

	// Never trust the client's Content-Type — sniff the bytes.
	mimeType = http.DetectContentType(raw)
	if !lim.allows(mimeType) {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, lim.typeRefusal())
		return nil, "", 0, 0, false
	}

	width, height, err = imageDimensions(raw, mimeType)
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "could not read image dimensions")
		return nil, "", 0, 0, false
	}
	// Measured from the sniffed image, not from anything the client said.
	// The client crops before uploading; the server does not re-encode (that
	// would mean decoding and re-compressing every upload to change nothing
	// the renderer does not already do), it just refuses a picture too big.
	if width <= 0 || height <= 0 || width > lim.MaxW || height > lim.MaxH {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, fmt.Sprintf("%s must be at most %dx%d pixels (got %dx%d)", lim.Label, lim.MaxW, lim.MaxH, width, height))
		return nil, "", 0, 0, false
	}

	return raw, mimeType, width, height, true
}
