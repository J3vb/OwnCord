package ws

import "encoding/binary"

// audioLevelExtID is the RTP header extension ID for RFC 6464 audio level.
const audioLevelExtID = 1

// extractAudioLevel parses raw RTP bytes to extract the audio level from
// a one-byte header extension (profile 0xBEDE) with ID == audioLevelExtID.
// Returns the 7-bit level (0=loudest, 127=silence) and true if found.
//
// This avoids a full rtp.Packet.Unmarshal on every packet (~50 pps/user).
func extractAudioLevel(buf []byte, n int) (level byte, ok bool) {
	if n < 12 {
		return 0, false // too short for RTP fixed header
	}

	// Check X bit (extension present) at byte 0, bit 4.
	if buf[0]&0x10 == 0 {
		return 0, false // no header extension
	}

	// CC = CSRC count (lower 4 bits of byte 0).
	cc := int(buf[0] & 0x0F)
	extOffset := 12 + 4*cc // skip fixed header + CSRCs

	// Need at least 4 bytes for extension header (profile + length).
	if n < extOffset+4 {
		return 0, false
	}

	// Extension profile must be 0xBEDE (one-byte header format).
	profile := binary.BigEndian.Uint16(buf[extOffset:])
	if profile != 0xBEDE {
		return 0, false
	}

	// Extension length in 32-bit words.
	extWords := int(binary.BigEndian.Uint16(buf[extOffset+2:]))
	extDataStart := extOffset + 4
	extDataEnd := extDataStart + extWords*4

	if n < extDataEnd {
		return 0, false // extension data extends past packet
	}

	// Walk one-byte header extension elements.
	// Format: ID (4 bits) | L (4 bits) | data[L+1 bytes]
	// ID=0 is padding, ID=15 terminates.
	pos := extDataStart
	for pos < extDataEnd {
		b := buf[pos]

		// Padding byte.
		if b == 0 {
			pos++
			continue
		}

		id := b >> 4
		dataLen := int(b&0x0F) + 1

		// ID=15 means end of extensions.
		if id == 15 {
			break
		}

		pos++ // advance past the ID|L byte

		if pos+dataLen > extDataEnd {
			break // malformed: data extends past extension block
		}

		if id == audioLevelExtID && dataLen >= 1 {
			// RFC 6464: V(1 bit) + level(7 bits)
			return buf[pos] & 0x7F, true
		}

		pos += dataLen
	}

	return 0, false
}
