package main

import (
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
)

// stepBVerify asks the restored server, through its public API, whether the install came back. Every check
// is attempted so one run names every broken one.
func (d *drill) stepBVerify(b *bState, problems *problemList) error {
	log, err := d.srv.log()
	if err != nil {
		return d.annotate(err)
	}
	if strings.Contains(log, "different erasure key") || saysHistoryGone(log) {
		problems.addf("the restored server's boot log reports a lost erasure key or history:\n%s", tailExcerpt(log))
	}
	if err := d.verifyOwner(b, problems); err != nil {
		return d.annotate(err)
	}
	res, err := checkTOTPSignIn(b.twoFA.name, b.secret, b.lastStep)
	if err != nil {
		return d.annotate(err)
	}
	if res.status != http.StatusOK || res.token == "" {
		problems.addf("the second-factor sign-in on the restored install was refused with %d: %s", res.status, res.detail)
	} else if err := d.verifyUpload(b, res.token, problems); err != nil {
		return d.annotate(err)
	}
	if err := d.verifyHistory(b, problems); err != nil {
		return d.annotate(err)
	}
	return d.verifyErased(b, problems)
}

func (d *drill) verifyOwner(b *bState, problems *problemList) error {
	in, err := passwordSignIn(fixtureUser, fixturePassword)
	if err != nil {
		return err
	}
	if in.status != http.StatusOK || in.token == "" {
		problems.addf("the owner's password sign-in on the restored install answered %d, want 200", in.status)
	}
	alive, _, err := authenticated(b.ownerToken)
	if err != nil {
		return err
	}
	if !alive {
		problems.addf("the owner's session from before the archive no longer authenticates on the restored install")
	}
	return nil
}

func (d *drill) verifyUpload(b *bState, token string, problems *problemList) error {
	got, err := fetchAttachment(d.baseURL(), token, b.fileID)
	if err != nil {
		problems.addf("the restored install cannot serve the upload by id: %v", err)
		return nil
	}
	if got.digest != fixturePayloadDigest || got.length != fixturePayloadSize {
		problems.addf("the restored upload is %d bytes with sha256 %s, want %d bytes with %s",
			got.length, got.digest, fixturePayloadSize, fixturePayloadDigest)
	}
	return nil
}

func (d *drill) verifyHistory(b *bState, problems *problemList) error {
	rows, err := channelHistory(b.ownerToken, b.channel.ID)
	if err != nil {
		return err
	}
	byID := make(map[int64]historyRow, len(rows))
	for _, row := range rows {
		byID[row.id] = row
	}
	for _, want := range b.seeded {
		row, ok := byID[want.id]
		switch {
		case !ok:
			problems.addf("message %d (%q) is missing from the restored history", want.id, want.content)
		case row.content != want.content || row.userID != want.userID:
			problems.addf("message %d is %q from user %d on the restored install, want %q from user %d",
				want.id, row.content, row.userID, want.content, want.userID)
		}
	}
	return nil
}

// verifyErased checks that the account erased before the archive is still erased.
func (d *drill) verifyErased(b *bState, problems *problemList) error {
	alive, _, err := authenticated(b.erased.token)
	if err != nil {
		return d.annotate(err)
	}
	if alive {
		problems.addf("the erased account's session from before the archive authenticates again on the restored install")
	}
	in, err := passwordSignIn(b.erased.name, drillPassword)
	if err != nil {
		return d.annotate(err)
	}
	switch in.status {
	case http.StatusUnauthorized:
	case http.StatusTooManyRequests:
		problems.addf("the erased account's sign-in was rate limited (429), so it did not show whether the account is gone")
	default:
		problems.addf("the erased account's password sign-in answered %d on the restored install, want 401", in.status)
	}
	rows, err := channelHistory(b.ownerToken, b.channel.ID)
	if err != nil {
		return d.annotate(err)
	}
	for _, row := range rows {
		if row.userID == b.erased.id {
			problems.addf("the erased account's message %d is back in the restored history", row.id)
		}
	}
	state, err := readMarkers(filepath.Join(d.dir, "data"))
	if err != nil {
		return d.annotate(err)
	}
	if state != b.markers {
		problems.addf("the restored deletion markers are %d with token %s, want %d with token %s",
			state.count, shortToken(state.token), b.markers.count, shortToken(b.markers.token))
	}
	return nil
}

// stepBNegative restores the same archive again without data/totp.key and runs the same TOTP check, which
// has to fail because of the key. That is the proof the check in the plain restore can fail.
func (d *drill) stepBNegative(b *bState, problems *problemList) error {
	if err := d.stop(); err != nil {
		return err
	}
	dir := filepath.Join(b.root, "restored-no-totp")
	if err := unpackArchive(b.archive, dir, stripTOTPKey); err != nil {
		return fmt.Errorf("restoring into %s: %w", filepath.Base(dir), err)
	}
	bootErr := d.bootAt(dir, "B-no-totp.log", fmt.Sprintf("OWNCORD_SECURITY_AUTH_RATE_LIMIT_MULTIPLIER=%d", drillAuthRateScale))
	signedIn, sawLine := false, false
	if bootErr == nil {
		res, err := checkTOTPSignIn(b.twoFA.name, b.secret, b.lastStep)
		if err != nil {
			return d.annotate(err)
		}
		signedIn = res.status == http.StatusOK
		log, err := d.srv.log()
		if err != nil {
			return d.annotate(err)
		}
		sawLine = strings.Contains(log, totpDecryptFailedLine)
		if err := d.stop(); err != nil {
			return err
		}
	}
	if err := classifyNegativeLeg(bootErr != nil, signedIn, sawLine); err != nil {
		if bootErr != nil {
			err = fmt.Errorf("%w: %w", err, bootErr)
		}
		problems.addf("without data/totp.key: %v", err)
		return nil
	}
	fmt.Printf("%s: without data/totp.key the TOTP check failed as it must, for the key\n", d.phase)
	return nil
}
