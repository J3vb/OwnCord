// Package discordimport reads a DiscordChatExporter JSON export and writes it
// into a new channel. The parser streams: it never holds the messages array.
// The runner copies local media into storage, inserts the history in chunks
// under one hidden account, and shows the channel only when it is complete.
package discordimport

import (
	"errors"
	"strings"
)

// ErrBadExport means the input is not a readable DiscordChatExporter file.
var ErrBadExport = errors.New("not a DiscordChatExporter JSON export")

// Guild is the export's server block.
type Guild struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Channel is the export's channel block.
type Channel struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Name  string `json:"name"`
	Topic string `json:"topic"`
}

// Header is everything before the messages array.
type Header struct {
	Guild   Guild
	Channel Channel
}

// Author is a message's writer as the export names them.
type Author struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Nickname string `json:"nickname"`
	Color    string `json:"color"`
	IsBot    bool   `json:"isBot"`
}

// DisplayName is the nickname when set, else the account name.
func (a Author) DisplayName() string {
	if n := strings.TrimSpace(a.Nickname); n != "" {
		return n
	}
	if n := strings.TrimSpace(a.Name); n != "" {
		return n
	}
	return "Unknown"
}

// Attachment is one file on a message. URL is a remote link or, in a zip
// export, a path inside the zip.
type Attachment struct {
	ID            string `json:"id"`
	URL           string `json:"url"`
	FileName      string `json:"fileName"`
	FileSizeBytes int64  `json:"fileSizeBytes"`
}

// Reference is the message a reply points at.
type Reference struct {
	MessageID string `json:"messageId"`
	ChannelID string `json:"channelId"`
}

// Message is the part of an exported message the import uses. Reactions,
// embeds, stickers and mentions are left in the file: they are not imported.
type Message struct {
	ID              string       `json:"id"`
	Type            string       `json:"type"`
	Timestamp       string       `json:"timestamp"`
	TimestampEdited *string      `json:"timestampEdited"`
	IsPinned        bool         `json:"isPinned"`
	Content         string       `json:"content"`
	Author          Author       `json:"author"`
	Attachments     []Attachment `json:"attachments"`
	Reference       *Reference   `json:"reference"`
}

// Importable reports whether the message type is imported. System messages
// (joins, boosts, calls, pins) are not.
func (m *Message) Importable() bool { return m.Type == "Default" || m.Type == "Reply" }
