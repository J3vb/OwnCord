package service

import (
	"fmt"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

// validateBannerColor normalizes a banner colour: trimmed, lower-case, #rgb or #rrggbb; "" clears it.
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

// mergeBanner resolves the banner columns a profile write stores: the patched value where supplied (empty
// clears), else the current row's.
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
