package auth

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
)

// maxCombiningRun is the most combining marks accepted in a row. Two covers
// every real script (a base letter plus a vowel sign and a tone mark) while
// stopping "Zalgo" text, whose stacked marks spill over neighbouring rows.
const maxCombiningRun = 2

// reservedUsernames are the names a registration may not take: the mention
// keywords, which would otherwise let an account impersonate an @everyone or
// @here ping target. Compared case-insensitively.
var reservedUsernames = []string{"everyone", "here"}

// ErrVisibleText is matched (errors.Is) by every ValidateVisibleText failure.
var ErrVisibleText = errors.New("invalid text")

// visibleTextError carries a predicate-style message ("must not contain ...")
// that a caller can prefix with its field name, while still matching
// ErrVisibleText.
type visibleTextError string

func (e visibleTextError) Error() string        { return string(e) }
func (e visibleTextError) Is(target error) bool { return target == ErrVisibleText }

// zwj is U+200D ZERO WIDTH JOINER, the one Cf character emoji sequences need.
const zwj = '\u200d'

// isVariationSelector reports U+FE0E / U+FE0F, which trail an emoji base.
func isVariationSelector(r rune) bool { return r == '︎' || r == '\ufe0f' }

func isSymbol(r rune) bool { return unicode.In(r, unicode.So, unicode.Sk) }

// isBlankFiller reports the default-ignorable characters that render as
// nothing (or as a blank letter) yet are not Cc/Cf: they would let a name or
// status look empty or impersonate another. U+FE00-FE0F are handled apart
// because emoji need FE0E/FE0F.
func isBlankFiller(r rune) bool {
	switch {
	case r == '\u034f', r == '\u115f', r == '\u1160', r == '\u3164', r == '\uffa0':
		return true
	case r >= '\u180b' && r <= '\u180f':
		return true
	case r >= 0xe0100 && r <= 0xe01ef:
		return true
	}
	return false
}

func isAnyVariationSelector(r rune) bool { return r >= '\ufe00' && r <= '\ufe0f' }

// isKeycapSelector reports whether runes[i] is the U+FE0F of a keycap emoji:
// a digit, '#' or '*', then U+FE0F, then U+20E3 COMBINING ENCLOSING KEYCAP.
func isKeycapSelector(runes []rune, i int) bool {
	if runes[i] != '\ufe0f' || i == 0 || i+1 >= len(runes) || runes[i+1] != '\u20e3' {
		return false
	}
	base := runes[i-1]
	return (base >= '0' && base <= '9') || base == '#' || base == '*'
}

// zwjJoinsSymbols reports whether the ZWJ at runes[i] sits between two
// symbols (So/Sk). Variation selectors after the left-hand symbol are skipped
// so that sequences such as heart + FE0F + ZWJ + fire still count.
func zwjJoinsSymbols(runes []rune, i int) bool {
	j := i - 1
	for j >= 0 && isVariationSelector(runes[j]) {
		j--
	}
	if j < 0 || i+1 >= len(runes) {
		return false
	}
	return isSymbol(runes[j]) && isSymbol(runes[i+1])
}

// ValidateVisibleText checks free text that is shown to other people on one
// line (display name, custom status, group DM name). It rejects:
//   - control characters (Cc), which covers line breaks and tabs;
//   - invisible format characters (Cf: zero-width, bidi overrides), except a
//     ZWJ directly between two symbols so emoji sequences survive;
//   - line and paragraph separators (U+2028, U+2029), which render as breaks;
//   - blank fillers (see isBlankFiller) and variation selectors, except
//     U+FE0E/U+FE0F straight after a symbol (So/Sk) so emoji keep working,
//     and the U+FE0F of a keycap (digit, '#' or '*', U+FE0F, U+20E3);
//   - more than two combining marks (Mn/Me) in a row.
//
// It does not trim, collapse or length-check: run CollapseSpaces first and the
// rune cap after. The returned error matches ErrVisibleText and reads as a
// predicate, so a caller prefixes its field name.
func ValidateVisibleText(s string) error {
	runes := []rune(s)
	run := 0
	for i, r := range runes {
		switch {
		case unicode.IsControl(r), unicode.In(r, unicode.Zl, unicode.Zp):
			return visibleTextError("must not contain control characters or line breaks")
		case isBlankFiller(r):
			return visibleTextError("must not contain invisible characters")
		case isAnyVariationSelector(r):
			if (r == '\ufe0e' || r == '\ufe0f') && i > 0 && isSymbol(runes[i-1]) {
				continue
			}
			if isKeycapSelector(runes, i) {
				continue
			}
			return visibleTextError("must not contain invisible characters")
		case unicode.In(r, unicode.Cf):
			if r == zwj && zwjJoinsSymbols(runes, i) {
				run = 0
				continue
			}
			return visibleTextError("must not contain invisible characters")
		}
		if unicode.In(r, unicode.Mn, unicode.Me) {
			run++
			if run > maxCombiningRun {
				return visibleTextError(fmt.Sprintf("must not stack more than %d combining marks", maxCombiningRun))
			}
		} else {
			run = 0
		}
	}
	return nil
}

// CollapseSpaces replaces every run of Unicode space separators (Zs: space,
// no-break space, em space, ...) with one ASCII space and trims the ends.
// Line breaks and tabs are not Zs, so they are left for ValidateVisibleText to
// refuse rather than being silently turned into spaces.
func CollapseSpaces(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	pendingSpace := false
	for _, r := range s {
		if unicode.Is(unicode.Zs, r) {
			pendingSpace = b.Len() > 0
			continue
		}
		if pendingSpace {
			b.WriteByte(' ')
			pendingSpace = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

// ValidateNewUsername is the strict check for a name being chosen: register,
// first-run setup and rename. It runs ValidateUsername (the loose check kept
// for login and recovery, so accounts that predate these rules still work) and
// then requires the name to be made of letters, decimal digits, '_', '.' and
// '-', plus combining marks (Mn/Mc) that follow a letter or another mark (at
// most two in a row). The first rune must be a letter or digit, so there are
// no spaces, and "everyone" and "here" are reserved.
func ValidateNewUsername(username string) error {
	if err := ValidateUsername(username); err != nil {
		return err
	}
	username = strings.TrimSpace(username)
	if isReservedUsername(username) {
		return fmt.Errorf("username is reserved")
	}
	var prev rune
	run := 0
	for i, r := range username {
		if isBlankFiller(r) || isAnyVariationSelector(r) {
			return fmt.Errorf("username must not contain invisible characters")
		}
		isMark := unicode.In(r, unicode.Mn, unicode.Mc)
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r):
			run = 0
		case r == '_' || r == '.' || r == '-':
			if i == 0 {
				return fmt.Errorf("username must start with a letter or digit")
			}
			run = 0
		case isMark:
			if i == 0 || (!unicode.IsLetter(prev) && !unicode.In(prev, unicode.Mn, unicode.Mc)) {
				return fmt.Errorf("username has a combining mark that does not follow a letter")
			}
			run++
			if run > maxCombiningRun {
				return fmt.Errorf("username must not stack more than %d combining marks", maxCombiningRun)
			}
		default:
			return fmt.Errorf("username may only contain letters, digits, '_', '.' and '-'")
		}
		if i == 0 && !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			return fmt.Errorf("username must start with a letter or digit")
		}
		prev = r
	}
	return nil
}

// isReservedUsername reports whether name is a reserved mention keyword.
func isReservedUsername(name string) bool {
	for _, reserved := range reservedUsernames {
		if strings.EqualFold(name, reserved) {
			return true
		}
	}
	return false
}
