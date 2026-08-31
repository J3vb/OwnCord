package admin_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
)

// TestAdminAPI_LogStreamTicketFlow_APIToken verifies that an API-token
// principal (headless client, no login session) can obtain a log stream
// ticket, redeem it for the SSE backfill, and that revoking the token
// invalidates tickets minted before the revocation.
func TestAdminAPI_LogStreamTicketFlow_APIToken(t *testing.T) {
	database := openAdminTestDB(t)
	logBuf := admin.NewRingBuffer(8)
	logBuf.Write(admin.LogEntry{Timestamp: "2026-07-31T10:00:00Z", Level: "INFO", Message: "hello from ring", Source: "server"})
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, logBuf, nil, nil, newTestModService(database), newTestRoleService(database), newTestSettingsService(database))

	// An admin user authenticated only by an API token — no session row exists.
	uid, err := database.CreateUser(context.Background(), "apitokenadmin", "$2a$12$placeholder", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	rawToken := "test-api-token-" + t.Name()
	tokenID, err := database.CreateAPIToken(context.Background(), uid, auth.HashToken(rawToken), "mcp-introspect", nil)
	if err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	ticketResp := doRequest(t, handler, http.MethodPost, "/logs/ticket", rawToken, nil)
	if ticketResp.Code != http.StatusOK {
		t.Fatalf("POST /logs/ticket with API token status = %d, want 200; body: %s", ticketResp.Code, ticketResp.Body.String())
	}
	var payload struct {
		Ticket string `json:"ticket"`
	}
	if err := json.Unmarshal(ticketResp.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal ticket response: %v", err)
	}
	if payload.Ticket == "" {
		t.Fatal("expected non-empty log stream ticket")
	}

	srv := httptest.NewServer(handler)
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/logs/stream?ticket="+payload.Ticket, nil)
	if err != nil {
		t.Fatalf("NewRequestWithContext: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("stream request failed: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("GET /logs/stream?ticket=... with API-token ticket status = %d, want 200; body: %s", resp.StatusCode, string(body))
	}
	sawBackfill := false
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") && strings.Contains(line, "hello from ring") {
			sawBackfill = true
			cancel() // stop the stream; we only need the backfill
			break
		}
	}
	if !sawBackfill {
		t.Fatal("expected SSE backfill to deliver the ring buffer entry")
	}

	// A ticket minted before revocation must not redeem after it.
	ticketResp = doRequest(t, handler, http.MethodPost, "/logs/ticket", rawToken, nil)
	if ticketResp.Code != http.StatusOK {
		t.Fatalf("POST /logs/ticket (second) status = %d, want 200; body: %s", ticketResp.Code, ticketResp.Body.String())
	}
	if err := json.Unmarshal(ticketResp.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal second ticket response: %v", err)
	}
	if _, err := database.RevokeAPIToken(context.Background(), tokenID); err != nil {
		t.Fatalf("RevokeAPIToken: %v", err)
	}
	revokedResp, err := http.Get(srv.URL + "/logs/stream?ticket=" + payload.Ticket)
	if err != nil {
		t.Fatalf("revoked-token stream request failed: %v", err)
	}
	defer revokedResp.Body.Close() //nolint:errcheck
	if revokedResp.StatusCode != http.StatusUnauthorized {
		body, _ := io.ReadAll(revokedResp.Body)
		t.Fatalf("revoked-token ticket status = %d, want 401; body: %s", revokedResp.StatusCode, string(body))
	}
}
