package service

import (
	"fmt"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

// validateBannerColor normalizes a banner colour: trimmed, lower-case, #rgb or
// #rrggbb. The empty string clears it and is returned as "".
func validateBannerColor(raw string) (string, error) {
	c := strings.ToLower(strings.TrimSpace(raw))
	if c == "" {
		return "", nil
	}
	if !hexColorRe.MatchString(c) {
		return "", fmt.Errorf("%w: banner_color must be a hex value like #5865f2", ErrBadRequest)
	}
	return c, nil
}

// cleanBannerPatch validates an optional banner colour from a ProfilePatch.
// nil means unchanged; a pointer to "" means cleared.
func cleanBannerPatch(raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	c, err := validateBannerColor(*raw)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// mergeBanner resolves the banner columns a profile write stores: the patched
// value where one was supplied (empty clears), the current row's otherwise.
// color is already validated by cleanBannerPatch.
func mergeBanner(current *db.User, id, color *string) (bannerID, bannerColor *string) {
	bannerID, bannerColor = current.BannerID, current.BannerColor
	if id != nil {
		bannerID = nullable(*id)
	}
	if color != nil {
		bannerColor = nullable(*color)
	}
	return bannerID, bannerColor
}
