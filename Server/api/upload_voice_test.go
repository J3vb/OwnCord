package api_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// WP 8.9: a voice message is an ordinary attachment that also carries its
// length and a small waveform, sent as two query parameters on the upload.

// oggOpusBody is a small Ogg container the sniffer reports as application/ogg.
func oggOpusBody() []byte {
	return append([]byte("OggS\x00\x02"), bytes.Repeat([]byte{0x01}, 600)...)
}

// wavBody is a small RIFF/WAVE file the sniffer reports as audio/wave.
func wavBody() []byte {
	return append([]byte("RIFF\x24\x00\x00\x00WAVEfmt "), make([]byte, 600)...)
}

func voiceWaveform(n int) string {
	raw := make([]byte, n)
	for i := range raw {
		raw[i] = byte(i * 7)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func voiceQuery(dur, wave string) string {
	q := url.Values{}
	if dur != "" {
		q.Set("voice_duration_ms", dur)
	}
	if wave != "" {
		q.Set("voice_waveform", wave)
	}
	return q.Encode()
}

func doVoiceUpload(t *testing.T, h *quotaHarness, rawQuery, filename string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := makeMultipartFile(t, "file", filename, content)
	target := "/api/v1/uploads"
	if rawQuery != "" {
		target += "?" + rawQuery
	}
	req := httptest.NewRequest(http.MethodPost, target, body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+h.token)
	rr := httptest.NewRecorder()
	h.router.ServeHTTP(rr, req)
	return rr
}

func attachmentRows(t *testing.T, h *quotaHarness) int {
	t.Helper()
	var n int
	if err := h.database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM attachments`).Scan(&n); err != nil {
		t.Fatalf("count attachments: %v", err)
	}
	return n
}

func TestUploadVoice_StoresAndReturnsDurationAndWaveform(t *testing.T) {
	for name, body := range map[string][]byte{"ogg": oggOpusBody(), "wav": wavBody()} {
		t.Run(name, func(t *testing.T) {
			h := newQuotaHarness(t, nil)
			wave := voiceWaveform(64)
			rr := doVoiceUpload(t, h, voiceQuery("4200", wave), "voice."+name, body)
			if rr.Code != http.StatusCreated {
				t.Fatalf("status = %d, want 201; body: %s", rr.Code, rr.Body.String())
			}
			var resp struct {
				ID         string `json:"id"`
				DurationMs int    `json:"duration_ms"`
				Waveform   string `json:"waveform"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if resp.DurationMs != 4200 || resp.Waveform != wave {
				t.Fatalf("response = %d, %q; want 4200, %q", resp.DurationMs, resp.Waveform, wave)
			}

			// Link it to a message and read it back the way a message list does.
			ctx := context.Background()
			const channelID = int64(1)
			if _, err := h.database.ExecContext(ctx, `INSERT INTO channels (id, name, type) VALUES (1, 'general', 'text')`); err != nil {
				t.Fatalf("insert channel: %v", err)
			}
			msgID, err := h.database.CreateMessage(ctx, channelID, h.userID, "", nil)
			if err != nil {
				t.Fatalf("CreateMessage: %v", err)
			}
			if _, err := h.database.LinkAttachmentsToMessage(ctx, msgID, h.userID, []string{resp.ID}); err != nil {
				t.Fatalf("LinkAttachmentsToMessage: %v", err)
			}
			got, err := h.database.GetAttachmentsByMessageIDs(ctx, []int64{msgID})
			if err != nil {
				t.Fatalf("GetAttachmentsByMessageIDs: %v", err)
			}
			atts := got[msgID]
			if len(atts) != 1 || atts[0].DurationMs == nil || *atts[0].DurationMs != 4200 || atts[0].Waveform == nil || *atts[0].Waveform != wave {
				t.Fatalf("linked attachment = %+v; want duration 4200 and the waveform", atts)
			}
			raw, _ := json.Marshal(atts[0])
			if !strings.Contains(string(raw), `"duration_ms":4200`) || !strings.Contains(string(raw), `"waveform":"`+wave+`"`) {
				t.Fatalf("attachment JSON lacks the voice fields: %s", raw)
			}

			// A forward clones the file; the clone keeps its player.
			files, err := h.database.ListForwardAttachments(ctx, msgID)
			if err != nil {
				t.Fatalf("ListForwardAttachments: %v", err)
			}
			if len(files) != 1 || files[0].DurationMs == nil || *files[0].DurationMs != 4200 || files[0].Waveform == nil || *files[0].Waveform != wave {
				t.Fatalf("forward snapshot = %+v; want the voice fields carried", files)
			}
		})
	}
}

func TestUploadVoice_WaveformIsStoredCanonically(t *testing.T) {
	h := newQuotaHarness(t, nil)
	// 0xFF 0xFF 0xFF encodes to "____"; the stored string is the re-encoding.
	rr := doVoiceUpload(t, h, voiceQuery("1000", "____"), "v.ogg", oggOpusBody())
	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d; body: %s", rr.Code, rr.Body.String())
	}
	var wave string
	if err := h.database.QueryRowContext(context.Background(), `SELECT waveform FROM attachments`).Scan(&wave); err != nil {
		t.Fatalf("read waveform: %v", err)
	}
	if wave != "____" {
		t.Fatalf("stored waveform = %q, want ____", wave)
	}
}

func TestUploadVoice_InvalidParametersAre400AndStoreNothing(t *testing.T) {
	cases := map[string]string{
		"duration alone":      voiceQuery("1000", ""),
		"waveform alone":      voiceQuery("", voiceWaveform(8)),
		"duration zero":       voiceQuery("0", voiceWaveform(8)),
		"duration too long":   voiceQuery("300001", voiceWaveform(8)),
		"duration negative":   voiceQuery("-5", voiceWaveform(8)),
		"duration signed":     voiceQuery("+5", voiceWaveform(8)),
		"duration not number": voiceQuery("abc", voiceWaveform(8)),
		"duration fractional": voiceQuery("1.5", voiceWaveform(8)),
		"duration huge":       voiceQuery("99999999999999999999", voiceWaveform(8)),
		"waveform not base64": voiceQuery("1000", "!!!!"),
		"waveform padded":     voiceQuery("1000", "AQI="),
		"waveform std alpha":  voiceQuery("1000", "a+b/"),
		"waveform too long":   voiceQuery("1000", voiceWaveform(257)),
		"duration twice":      "voice_duration_ms=1&voice_duration_ms=2&voice_waveform=AQID",
		"waveform empty":      "voice_duration_ms=1000&voice_waveform=",
	}
	for name, q := range cases {
		t.Run(name, func(t *testing.T) {
			h := newQuotaHarness(t, nil)
			rr := doVoiceUpload(t, h, q, "v.ogg", oggOpusBody())
			assertErrorCode(t, rr, http.StatusBadRequest, "BAD_REQUEST")
			if h.filesOnDisk(t) != 0 || attachmentRows(t, h) != 0 {
				t.Fatal("a refused voice upload stored a file or a row")
			}
			if got := h.used(t); got != 0 {
				t.Fatalf("quota counter = %d after a refusal, want 0", got)
			}
		})
	}
}

func TestUploadVoice_BoundaryValuesAreAccepted(t *testing.T) {
	for name, q := range map[string]string{
		"min duration, 1 byte":   voiceQuery("1", voiceWaveform(1)),
		"max duration, 256 byte": voiceQuery("300000", voiceWaveform(256)),
	} {
		t.Run(name, func(t *testing.T) {
			h := newQuotaHarness(t, nil)
			rr := doVoiceUpload(t, h, q, "v.ogg", oggOpusBody())
			if rr.Code != http.StatusCreated {
				t.Fatalf("status = %d; body: %s", rr.Code, rr.Body.String())
			}
		})
	}
}

// The parameters are validated before the quota is reserved: a user whose
// quota is full still gets the 400, not a 507.
func TestUploadVoice_ParametersAreCheckedBeforeQuota(t *testing.T) {
	h := newQuotaHarness(t, nil)
	h.limits(t, 1, 0, nil)
	rr := doVoiceUpload(t, h, voiceQuery("0", voiceWaveform(8)), "v.ogg", oggOpusBody())
	assertErrorCode(t, rr, http.StatusBadRequest, "BAD_REQUEST")
}

func TestUploadVoice_NonAudioTypeIsRefusedAndItsFileDeleted(t *testing.T) {
	h := newQuotaHarness(t, nil)
	rr := doVoiceUpload(t, h, voiceQuery("1000", voiceWaveform(8)), "pic.png", makePNGBytes(t, 4, 4))
	assertErrorCode(t, rr, http.StatusBadRequest, "BAD_REQUEST")
	if h.filesOnDisk(t) != 0 {
		t.Fatal("a refused voice upload left its file on disk")
	}
	if attachmentRows(t, h) != 0 {
		t.Fatal("a refused voice upload left a row")
	}
	if got := h.used(t); got != 0 {
		t.Fatalf("quota counter = %d after a refusal, want 0", got)
	}
}

func TestUploadVoice_PlainUploadIsUnchanged(t *testing.T) {
	h := newQuotaHarness(t, nil)
	rr := doVoiceUpload(t, h, "", "v.ogg", oggOpusBody())
	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, k := range []string{"duration_ms", "waveform"} {
		if _, ok := resp[k]; ok {
			t.Errorf("plain upload response carries %q", k)
		}
	}
	var dur, wave any
	if err := h.database.QueryRowContext(context.Background(), `SELECT duration_ms, waveform FROM attachments`).Scan(&dur, &wave); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if dur != nil || wave != nil {
		t.Errorf("plain upload row has duration %v, waveform %v; want NULL", dur, wave)
	}
}

// A client retries after a network drop with the same clip: each upload is its
// own attachment, there is no dedupe.
func TestUploadVoice_SameClipTwiceMakesTwoIndependentRows(t *testing.T) {
	h := newQuotaHarness(t, nil)
	q := voiceQuery("2500", voiceWaveform(32))
	ids := map[string]bool{}
	for range 2 {
		rr := doVoiceUpload(t, h, q, "v.ogg", oggOpusBody())
		if rr.Code != http.StatusCreated {
			t.Fatalf("status = %d; body: %s", rr.Code, rr.Body.String())
		}
		var resp struct{ ID string }
		_ = json.Unmarshal(rr.Body.Bytes(), &resp)
		ids[resp.ID] = true
	}
	if len(ids) != 2 || attachmentRows(t, h) != 2 || h.filesOnDisk(t) != 2 {
		t.Fatalf("ids %d, rows %d, files %d; want 2 independent uploads", len(ids), attachmentRows(t, h), h.filesOnDisk(t))
	}
	// Discarding one leaves the other intact.
	for id := range ids {
		req := httptest.NewRequest(http.MethodDelete, "/api/v1/uploads/"+id, nil)
		req.Header.Set("Authorization", "Bearer "+h.token)
		rr := httptest.NewRecorder()
		h.router.ServeHTTP(rr, req)
		if rr.Code != http.StatusNoContent {
			t.Fatalf("discard: %d %s", rr.Code, rr.Body.String())
		}
		break
	}
	if attachmentRows(t, h) != 1 || h.filesOnDisk(t) != 1 {
		t.Fatalf("after discarding one: rows %d, files %d; want 1, 1", attachmentRows(t, h), h.filesOnDisk(t))
	}
}

// A body cut off mid-upload leaves no row and no file, and releases the charge.
func TestUploadVoice_BodyCutMidUploadLeavesNothing(t *testing.T) {
	h := newQuotaHarness(t, nil)
	h.limits(t, 0, 0, nil)
	body, contentType := makeMultipartFile(t, "file", "v.ogg", append(oggOpusBody(), bytes.Repeat([]byte("q"), 4<<20)...))
	ctx, cancel := context.WithCancel(context.Background())
	reader := &blockThenCancelReader{r: body, budget: 1 << 20, ready: make(chan struct{}), done: ctx.Done(), err: ctx.Err}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads?"+voiceQuery("3000", voiceWaveform(16)), reader)
	req.ContentLength = int64(body.Len())
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+h.token)
	req = req.WithContext(ctx)
	rr := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		h.router.ServeHTTP(rr, req)
		close(done)
	}()
	<-reader.ready
	cancel()
	<-done

	if rr.Code == http.StatusCreated {
		t.Fatalf("a cut-off voice upload was created: %s", rr.Body.String())
	}
	if attachmentRows(t, h) != 0 {
		t.Fatal("a cut-off voice upload left a row")
	}
	if h.filesOnDisk(t) != 0 {
		t.Fatal("a cut-off voice upload left a file")
	}
	if got := h.used(t); got != 0 {
		t.Fatalf("quota counter = %d after a cut-off upload, want 0", got)
	}
}
