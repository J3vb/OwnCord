package db

// AttachmentInfo is the attachment shape in API responses.
type AttachmentInfo struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	Mime     string `json:"mime"`
	URL      string `json:"url"`
	Width    *int   `json:"width,omitempty"`
	Height   *int   `json:"height,omitempty"`
	// DurationMs and Waveform are set only on a voice message's attachment:
	// the clip length and base64url (unpadded) amplitude bytes.
	DurationMs *int    `json:"duration_ms,omitempty"`
	Waveform   *string `json:"waveform,omitempty"`
}
