package api

import (
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

// Voice message limits. A voice message is an ordinary attachment that
// also carries its length and a small waveform, so a client can draw the player
// before it has downloaded the file.
const (
	voiceMaxDurationMS = 300000 // five minutes
	voiceMaxWaveform   = 256    // decoded bytes
)

// voiceMeta is the parsed voice_duration_ms and voice_waveform query pair of
// POST /api/v1/uploads. The zero value is a normal upload.
type voiceMeta struct {
	present    bool
	durationMs int
	// waveform is the canonical base64url (unpadded) encoding of the decoded
	// bytes, which is what is stored and returned.
	waveform string
}

// errVoiceParams marks a refusal that is the client's to fix; its text is safe
// to send back.
var errVoiceParams = errors.New("invalid voice parameters")

// parseVoiceMeta reads the two optional voice query parameters. Both absent is
// a normal upload; exactly one, a bad number, or a bad waveform is an error.
// They are query parameters, not form fields, because the multipart body is
// streamed and findFilePart skips every non-file part.
func parseVoiceMeta(q url.Values) (voiceMeta, error) {
	durRaw, hasDur := q["voice_duration_ms"]
	waveRaw, hasWave := q["voice_waveform"]
	if !hasDur && !hasWave {
		return voiceMeta{}, nil
	}
	if !hasDur || !hasWave {
		return voiceMeta{}, fmt.Errorf("%w: voice_duration_ms and voice_waveform must be sent together", errVoiceParams)
	}
	if len(durRaw) != 1 || len(waveRaw) != 1 {
		return voiceMeta{}, fmt.Errorf("%w: each voice parameter may appear once", errVoiceParams)
	}
	dur, err := parseVoiceDuration(durRaw[0])
	if err != nil {
		return voiceMeta{}, err
	}
	wave, err := parseVoiceWaveform(waveRaw[0])
	if err != nil {
		return voiceMeta{}, err
	}
	return voiceMeta{present: true, durationMs: dur, waveform: wave}, nil
}

func parseVoiceDuration(s string) (int, error) {
	bad := fmt.Errorf("%w: voice_duration_ms must be a whole number from 1 to %d", errVoiceParams, voiceMaxDurationMS)
	if s == "" || len(s) > 6 {
		return 0, bad
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, bad
		}
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 || n > voiceMaxDurationMS {
		return 0, bad
	}
	return n, nil
}

func parseVoiceWaveform(s string) (string, error) {
	bad := fmt.Errorf("%w: voice_waveform must be base64url without padding, 1 to %d bytes", errVoiceParams, voiceMaxWaveform)
	if s == "" || len(s) > base64.RawURLEncoding.EncodedLen(voiceMaxWaveform) {
		return "", bad
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil || len(raw) < 1 || len(raw) > voiceMaxWaveform {
		return "", bad
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// voiceMimeAllowed reports whether a sniffed type can be a voice recording.
func voiceMimeAllowed(mimeType string) bool {
	base, _, _ := strings.Cut(mimeType, ";")
	base = strings.ToLower(strings.TrimSpace(base))
	return strings.HasPrefix(base, "audio/") || base == "video/webm" || base == "video/mp4" || base == "application/ogg"
}

// writeVoiceParamError answers a parseVoiceMeta failure with a 400 whose body
// names the problem without echoing the input.
func writeVoiceParamError(w http.ResponseWriter, err error) {
	slog.Debug("upload refused: voice parameters", "error", err)
	msg := strings.TrimPrefix(err.Error(), errVoiceParams.Error()+": ")
	writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, msg)
}

// checkStored refuses a voice upload whose sniffed type is not an audio
// recording: it deletes the stored file, answers 400 and reports false. A
// normal upload always passes.
func (v voiceMeta) checkStored(w http.ResponseWriter, store FileStore, stored storedUpload) bool {
	if !v.present || voiceMimeAllowed(stored.mime) {
		return true
	}
	if delErr := store.Delete(stored.id); delErr != nil {
		slog.Error("failed to clean up refused upload file", "stored_as", stored.id, "error", delErr)
	}
	writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "a voice message must be an audio recording")
	return false
}

// record builds the attachment row of a stored upload, with the voice fields
// when this is a voice upload.
func (v voiceMeta) record(userID int64, filename string, stored storedUpload) service.AttachmentRecord {
	rec := service.AttachmentRecord{
		ID:         stored.id,
		UploaderID: userID,
		Filename:   filename,
		MimeType:   stored.mime,
		Size:       stored.size,
		Width:      stored.width,
		Height:     stored.height,
	}
	if v.present {
		d, wv := v.durationMs, v.waveform
		rec.DurationMs, rec.Waveform = &d, &wv
	}
	return rec
}
