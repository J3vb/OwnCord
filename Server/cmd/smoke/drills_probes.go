package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

func get(path string, token string, out any) error {
	return request(http.MethodGet, defaultBaseURL+path, token, "", nil, http.StatusOK, out)
}

func wantStatus(method, path, token string, status int) error {
	return request(method, defaultBaseURL+path, token, "", nil, status, nil)
}

// healthBody is GET /health's shape: unauthenticated, so the reason names a subsystem and nothing more.
type healthBody struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

// healthOf reads /health, decoding on 200 and 503: a degraded server answers 503 with the asserted reason.
func healthOf() (healthBody, int, error) {
	req, err := http.NewRequest(http.MethodGet, defaultBaseURL+"/health", nil) //nolint:noctx // bounded by the client Timeout
	if err != nil {
		return healthBody{}, 0, err
	}
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return healthBody{}, 0, fmt.Errorf("reading /health: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	var body healthBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return healthBody{}, resp.StatusCode, fmt.Errorf("decoding /health: %w", err)
	}
	return body, resp.StatusCode, nil
}

func auditLog(token string) ([]auditRow, error) {
	var rows []auditRow
	if err := get("/admin/api/audit-log?limit=200", token, &rows); err != nil {
		return nil, fmt.Errorf("reading the audit log: %w", err)
	}
	return rows, nil
}

type auditRow struct {
	Action       string `json:"action"`
	Detail       string `json:"detail"`
	SubjectToken string `json:"subject_token"`
}

// livekitHealth reads the diagnostics endpoint's view of the SFU. The endpoint
// (/api/v1/diagnostics/connectivity) is administrator-gated and rate-limited to five requests a minute, so
// call it once per phase, never in a retry loop: a 429 read as "the SFU is down" would invert phase S. The
// field is voice.livekit_health (livekit_healthy is a different field on the metrics endpoint).
func livekitHealth(token string) (bool, error) {
	var diag struct {
		Voice struct {
			LiveKitHealth bool `json:"livekit_health"`
			Enabled       bool `json:"enabled"`
		} `json:"voice"`
	}
	if err := get("/api/v1/diagnostics/connectivity", token, &diag); err != nil {
		return false, fmt.Errorf("reading the SFU's health: %w", err)
	}
	return diag.Voice.LiveKitHealth, nil
}

type channelRow struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

// pickChannel returns the install's channel of a type. The setup wizard creates one of each, so a missing one
// means the install is not what the fixture believes.
func pickChannel(token, kind string) (channelRow, error) {
	var rows []channelRow
	if err := get("/api/v1/channels", token, &rows); err != nil {
		return channelRow{}, fmt.Errorf("listing channels: %w", err)
	}
	for _, row := range rows {
		if row.Type == kind {
			return row, nil
		}
	}
	return channelRow{}, fmt.Errorf("the install has no %s channel, only %v", kind, rows)
}

// inviteMaxUses is how many registrations one drill invite admits.
const inviteMaxUses = 10

func createInvite(baseURL, token string) (string, error) {
	body, err := json.Marshal(map[string]any{"max_uses": inviteMaxUses, "expires_in_hours": 24})
	if err != nil {
		return "", err
	}
	var resp struct {
		Code string `json:"code"`
	}
	if err := request(http.MethodPost, baseURL+"/api/v1/invites", token, "application/json",
		bytes.NewReader(body), http.StatusCreated, &resp); err != nil {
		return "", fmt.Errorf("creating an invite: %w", err)
	}
	if resp.Code == "" {
		return "", errors.New("the invite endpoint returned 201 with no code")
	}
	return resp.Code, nil
}

// registerUser registers the account phase R erases through the public invitee endpoint, so the erasure runs
// against a user the server itself made.
func registerUser(baseURL, invite, username string) (string, int64, error) {
	body, err := json.Marshal(map[string]any{
		"username":    username,
		"password":    drillPassword,
		"invite_code": invite,
	})
	if err != nil {
		return "", 0, err
	}
	var resp struct {
		Token string `json:"token"`
		User  struct {
			ID int64 `json:"id"`
		} `json:"user"`
	}
	if err := request(http.MethodPost, baseURL+"/api/v1/auth/register", "", "application/json",
		bytes.NewReader(body), http.StatusCreated, &resp); err != nil {
		return "", 0, fmt.Errorf("registering %s: %w", username, err)
	}
	if resp.Token == "" || resp.User.ID == 0 {
		return "", 0, fmt.Errorf("registering %s returned 201 with no session token or user id", username)
	}
	return resp.Token, resp.User.ID, nil
}

func authenticated(token string) (bool, string, error) {
	req, err := http.NewRequest(http.MethodGet, defaultBaseURL+"/api/v1/auth/me", nil) //nolint:noctx // bounded by the client Timeout
	if err != nil {
		return false, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return false, "", fmt.Errorf("checking a session: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusUnauthorized {
		return false, "", nil
	}
	if resp.StatusCode != http.StatusOK {
		return false, "", fmt.Errorf("GET /api/v1/auth/me: got %s, want 200 or 401", resp.Status)
	}
	var me struct {
		Username string `json:"username"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		return false, "", fmt.Errorf("decoding /api/v1/auth/me: %w", err)
	}
	return true, me.Username, nil
}

func messageCount(token string, channelID int64) (int, error) {
	var resp struct {
		Messages []struct {
			User struct {
				ID int64 `json:"id"`
			} `json:"user"`
		} `json:"messages"`
	}
	if err := get(fmt.Sprintf("/api/v1/channels/%d/messages?limit=100", channelID), token, &resp); err != nil {
		return 0, fmt.Errorf("listing messages: %w", err)
	}
	return len(resp.Messages), nil
}

// readWhileRestoring issues the paginated messages GET the reader pool serves while the restore is asked for,
// so the restore runs with a reader open, which a restore that waited on readers would block on.
func readWhileRestoring(token string, channelID int64) <-chan string {
	out := make(chan string, 1)
	go func() {
		defer close(out)
		url := fmt.Sprintf("%s/api/v1/channels/%d/messages?limit=100", defaultBaseURL, channelID)
		req, err := http.NewRequest(http.MethodGet, url, nil) //nolint:noctx // bounded by the client Timeout
		if err != nil {
			out <- "the reader never left: " + err.Error()
			return
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := fixtureClient.Do(req)
		if err != nil {
			out <- "the reader was cut off: " + err.Error()
			return
		}
		defer func() { _ = resp.Body.Close() }()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		out <- "the reader got " + resp.Status
	}()
	return out
}

func ownerID(token string) (int64, error) {
	var me struct {
		ID int64 `json:"id"`
	}
	if err := get("/api/v1/auth/me", token, &me); err != nil {
		return 0, fmt.Errorf("reading the owner's id: %w", err)
	}
	if me.ID == 0 {
		return 0, errors.New("the session reports no user id")
	}
	return me.ID, nil
}

// uploadStatus posts the fixture attachment and reports status and body: phase D asserts a refusal (507
// STORAGE_LOW_DISK) that request() would report as a transport failure.
func uploadStatus(token string) (int, string, error) {
	body, contentType, err := multipartUpload()
	if err != nil {
		return 0, "", err
	}
	req, err := http.NewRequest(http.MethodPost, defaultBaseURL+"/api/v1/uploads", bytes.NewReader(body)) //nolint:noctx // bounded by the client Timeout
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", contentType)
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return 0, "", fmt.Errorf("uploading: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return resp.StatusCode, strings.TrimSpace(string(detail)), nil
}

func backupStatus(token string) (int, string, error) {
	req, err := http.NewRequest(http.MethodPost, defaultBaseURL+"/admin/api/backup", nil) //nolint:noctx // bounded by the client Timeout
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return 0, "", fmt.Errorf("taking a backup: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return resp.StatusCode, strings.TrimSpace(string(detail)), nil
}
