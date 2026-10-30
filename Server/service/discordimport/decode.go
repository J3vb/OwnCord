package discordimport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Visitor receives the export piece by piece. Header is called once, before
// the first message (and also for an export with none). A non-nil error from
// either stops the decode and is returned as is.
type Visitor struct {
	Header  func(Header) error
	Message func(Message) error
}

// Summary is what the decode saw; MessageCount is 0 until the end because the
// exporter writes it after the messages.
type Summary struct {
	MessageCount int
	Seen         int
}

// Decode streams a DiscordChatExporter JSON document one message at a time, so
// memory stays flat for any export size. The channel block must precede the
// messages, as the exporter writes it. ctx is checked between messages.
func Decode(ctx context.Context, r io.Reader, v Visitor) (Summary, error) {
	var sum Summary
	dec := json.NewDecoder(r)
	if err := expectDelim(dec, '{'); err != nil {
		return sum, err
	}
	var header Header
	haveChannel, headerSent := false, false
	sendHeader := func() error {
		if headerSent {
			return nil
		}
		headerSent = true
		if v.Header != nil {
			return v.Header(header)
		}
		return nil
	}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return sum, fmt.Errorf("%w: %w", ErrBadExport, err)
		}
		key, _ := keyTok.(string)
		switch key {
		case "guild":
			err = dec.Decode(&header.Guild)
		case "channel":
			err = dec.Decode(&header.Channel)
			haveChannel = true
		case "messageCount":
			err = dec.Decode(&sum.MessageCount)
		case "messages":
			if !haveChannel {
				return sum, fmt.Errorf("%w: the channel block must come before the messages", ErrBadExport)
			}
			if herr := sendHeader(); herr != nil {
				return sum, herr
			}
			err = decodeMessages(ctx, dec, v, &sum)
		default:
			var skip json.RawMessage
			err = dec.Decode(&skip)
		}
		if err != nil {
			return sum, wrapDecode(err)
		}
	}
	if err := expectDelim(dec, '}'); err != nil {
		return sum, err
	}
	if !haveChannel {
		return sum, fmt.Errorf("%w: no channel block", ErrBadExport)
	}
	if err := sendHeader(); err != nil {
		return sum, err
	}
	return sum, nil
}

func decodeMessages(ctx context.Context, dec *json.Decoder, v Visitor, sum *Summary) error {
	if err := expectDelim(dec, '['); err != nil {
		return err
	}
	for dec.More() {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("import stopped: %w", err)
		}
		var m Message
		if err := dec.Decode(&m); err != nil {
			return err
		}
		sum.Seen++
		if v.Message != nil {
			if err := v.Message(m); err != nil {
				return err
			}
		}
	}
	return expectDelim(dec, ']')
}

func expectDelim(dec *json.Decoder, want json.Delim) error {
	tok, err := dec.Token()
	if err != nil {
		return fmt.Errorf("%w: %w", ErrBadExport, err)
	}
	if d, ok := tok.(json.Delim); !ok || d != want {
		return fmt.Errorf("%w: expected %q", ErrBadExport, string(want))
	}
	return nil
}

// wrapDecode marks a JSON syntax or type error as a bad export and leaves the
// visitor's own errors (and cancellation) alone.
func wrapDecode(err error) error {
	if _, ok := errors.AsType[*json.SyntaxError](err); ok {
		return fmt.Errorf("%w: %w", ErrBadExport, err)
	}
	if _, ok := errors.AsType[*json.UnmarshalTypeError](err); ok {
		return fmt.Errorf("%w: %w", ErrBadExport, err)
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return fmt.Errorf("%w: %w", ErrBadExport, err)
	}
	return err
}
