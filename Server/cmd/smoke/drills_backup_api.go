package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// postJSON posts a body and reports the status and the start of the answer, whatever the status is: a drill
// that expects a refusal must read it, not have request() turn it into an error.
func postJSON(path, token string, body any) (int, []byte, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequest(http.MethodPost, defaultBaseURL+path, bytes.NewReader(raw)) //nolint:noctx // bounded by the client Timeout
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("POST %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	answer, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return 0, nil, fmt.Errorf("reading POST %s: %w", path, err)
	}
	return resp.StatusCode, answer, nil
}

// signIn is one password sign-in: its status, and what a 200 carried.
type signIn struct {
	status       int
	token        string
	partialToken string
	requires2FA  bool
}

func passwordSignIn(username, password string) (signIn, error) {
	status, answer, err := postJSON("/api/v1/auth/login", "", map[string]string{"username": username, "password": password})
	if err != nil {
		return signIn{}, err
	}
	out := signIn{status: status}
	if status != http.StatusOK {
		return out, nil
	}
	var body struct {
		Token        string `json:"token"`
		PartialToken string `json:"partial_token"`
		Requires2FA  bool   `json:"requires_2fa"`
	}
	if err := json.Unmarshal(answer, &body); err != nil {
		return signIn{}, fmt.Errorf("decoding the sign-in answer: %w", err)
	}
	out.token, out.partialToken, out.requires2FA = body.Token, body.PartialToken, body.Requires2FA
	return out, nil
}

// enrolTOTP starts the second-factor enrolment and returns the secret the authenticator would hold.
func enrolTOTP(token string) (string, error) {
	var resp struct {
		QRURI string `json:"qr_uri"`
	}
	status, answer, err := postJSON("/api/v1/users/me/totp/enable", token, map[string]string{"password": drillPassword})
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("starting the TOTP enrolment: got %d: %s", status, strings.TrimSpace(string(answer)))
	}
	if err := json.Unmarshal(answer, &resp); err != nil {
		return "", fmt.Errorf("decoding the TOTP enrolment: %w", err)
	}
	return secretFromURI(resp.QRURI)
}

// confirmTOTP finishes the enrolment with a code from the drill's own generator and returns the step the code
// belongs to.
func confirmTOTP(token, secret string) (int64, error) {
	now := time.Now()
	code, err := totpCode(secret, now)
	if err != nil {
		return 0, err
	}
	status, answer, err := postJSON("/api/v1/users/me/totp/confirm", token, map[string]string{"password": drillPassword, "code": code})
	if err != nil {
		return 0, err
	}
	if status != http.StatusOK && status != http.StatusNoContent {
		return 0, fmt.Errorf("confirming the TOTP enrolment: got %d: %s", status, strings.TrimSpace(string(answer)))
	}
	return totpStep(now), nil
}

// totpResult is the outcome of the full two-step sign-in of an account with a second factor.
type totpResult struct {
	status int    // of verify-totp
	token  string // the session, on 200
	detail string // the answer's start, for a report
	step   int64  // the step the code was made for
}

// checkTOTPSignIn is the one TOTP check both the restore and its negative leg run: sign in with the password,
// expect a second-factor challenge, wait for a step after lastUsed, then answer it with a code from the
// drill's own generator. It reports what verify-totp said and judges nothing; a challenge that never came is
// an error, since it is not the question under test.
func checkTOTPSignIn(username, secret string, lastUsed int64) (totpResult, error) {
	if wait := nextFreshTOTPStep(lastUsed, time.Now()); wait > 0 {
		fmt.Printf("waiting %s for a TOTP step after the last one used\n", wait.Round(time.Second))
		time.Sleep(wait + time.Second)
	}
	first, err := passwordSignIn(username, drillPassword)
	if err != nil {
		return totpResult{}, err
	}
	if first.status != http.StatusOK || !first.requires2FA || first.partialToken == "" {
		return totpResult{}, fmt.Errorf("signing %s in with the password gave status %d, 2fa required %t, want a 200 with a second-factor challenge",
			username, first.status, first.requires2FA)
	}
	now := time.Now()
	code, err := totpCode(secret, now)
	if err != nil {
		return totpResult{}, err
	}
	status, answer, err := postJSON("/api/v1/auth/verify-totp", first.partialToken, map[string]string{"code": code})
	if err != nil {
		return totpResult{}, err
	}
	res := totpResult{status: status, detail: strings.TrimSpace(string(answer)), step: totpStep(now)}
	if status == http.StatusOK {
		var body struct {
			Token string `json:"token"`
		}
		if err := json.Unmarshal(answer, &body); err != nil {
			return totpResult{}, fmt.Errorf("decoding the verify-totp answer: %w", err)
		}
		res.token = body.Token
	}
	return res, nil
}

// historyRow is one message as the history lists it.
type historyRow struct {
	id      int64
	content string
	userID  int64
}

func channelHistory(token string, channelID int64) ([]historyRow, error) {
	var resp struct {
		Messages []struct {
			ID      int64  `json:"id"`
			Content string `json:"content"`
			User    struct {
				ID int64 `json:"id"`
			} `json:"user"`
		} `json:"messages"`
	}
	if err := get(fmt.Sprintf("/api/v1/channels/%d/messages?limit=100", channelID), token, &resp); err != nil {
		return nil, fmt.Errorf("reading the message history: %w", err)
	}
	rows := make([]historyRow, 0, len(resp.Messages))
	for _, m := range resp.Messages {
		rows = append(rows, historyRow{id: m.ID, content: m.Content, userID: m.User.ID})
	}
	return rows, nil
}

// seededMessage is one message the fixture sent and the id the server gave it.
type seededMessage struct {
	id      int64
	content string
	userID  int64
}

// sendSeeded sends n messages over a fresh session and keeps what the server answered with, paced under the
// chat rate limit.
func sendSeeded(token string, userID, channelID int64, label string, n int) ([]seededMessage, error) {
	c, err := dialWS(token)
	if err != nil {
		return nil, err
	}
	defer c.close()
	out := make([]seededMessage, 0, n)
	for i := range n {
		text := fmt.Sprintf("%s message %d", label, i)
		frame, err := c.chatSend(channelID, text)
		if err != nil {
			return nil, fmt.Errorf("%s sending message %d: %w", label, i, err)
		}
		if err := wantOK(frame, "chat_send_ok"); err != nil {
			return nil, fmt.Errorf("%s sending message %d: %w", label, i, err)
		}
		var ok struct {
			MessageID int64 `json:"message_id"`
		}
		if err := json.Unmarshal(frame.Payload, &ok); err != nil || ok.MessageID == 0 {
			return nil, fmt.Errorf("%s sending message %d: the acknowledgement carries no message id", label, i)
		}
		out = append(out, seededMessage{id: ok.MessageID, content: text, userID: userID})
		time.Sleep(drillFullSendPause)
	}
	return out, nil
}

// backupListEntry is one row of the owner's backup list.
type backupListEntry struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

func listBackupEntries(token string) ([]backupListEntry, error) {
	var entries []backupListEntry
	if err := get("/admin/api/backups", token, &entries); err != nil {
		return nil, fmt.Errorf("listing backups: %w", err)
	}
	return entries, nil
}

// firstFullArchive picks a stored full archive from the list.
func firstFullArchive(entries []backupListEntry) (string, bool) {
	for _, e := range entries {
		if e.Kind == "full" {
			return e.Name, true
		}
	}
	return "", false
}

// downloadArchive takes the full archive through the owner's download route and writes it to dest.
func downloadArchive(token, dest string) error {
	req, err := http.NewRequest(http.MethodGet, defaultBaseURL+"/admin/api/archive", nil) //nolint:noctx // bounded by the client Timeout
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return fmt.Errorf("downloading the archive: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("downloading the archive: got %s, want 200: %s", resp.Status, bytes.TrimSpace(detail))
	}
	f, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		_ = f.Close()
		return fmt.Errorf("downloading the archive: %w", err)
	}
	return f.Close()
}
