package ws

import (
	"encoding/binary"
	"testing"
)

// buildRTPPacket constructs a minimal RTP packet with optional one-byte
// header extensions. csrcCount specifies the number of dummy CSRCs.
func buildRTPPacket(csrcCount int, extensions []struct{ id, value byte }) []byte {
	// Fixed header: V=2, P=0, X=(1 if extensions), CC=csrcCount
	header := make([]byte, 12+4*csrcCount)
	header[0] = 0x80 | byte(csrcCount) // V=2, CC
	header[1] = 111                     // PT (opus)
	binary.BigEndian.PutUint16(header[2:], 1)          // seq
	binary.BigEndian.PutUint32(header[4:], 1000)       // timestamp
	binary.BigEndian.PutUint32(header[8:], 0xDEADBEEF) // SSRC

	// Fill dummy CSRCs.
	for i := 0; i < csrcCount; i++ {
		binary.BigEndian.PutUint32(header[12+4*i:], uint32(i+1))
	}

	if len(extensions) == 0 {
		return header
	}

	// Set X bit.
	header[0] |= 0x10

	// Build one-byte extension block.
	// Each element: 1 byte (ID<<4 | L) + (L+1) data bytes.
	// For simplicity each extension here has 1 byte of data (L=0).
	var extData []byte
	for _, ext := range extensions {
		extData = append(extData, ext.id<<4) // ID | L=0 (1 byte data)
		extData = append(extData, ext.value)
	}

	// Pad to 32-bit boundary.
	for len(extData)%4 != 0 {
		extData = append(extData, 0x00)
	}

	extWords := len(extData) / 4
	extHeader := make([]byte, 4)
	binary.BigEndian.PutUint16(extHeader[0:], 0xBEDE)
	binary.BigEndian.PutUint16(extHeader[2:], uint16(extWords))

	pkt := make([]byte, 0, len(header)+len(extHeader)+len(extData))
	pkt = append(pkt, header...)
	pkt = append(pkt, extHeader...)
	pkt = append(pkt, extData...)
	return pkt
}

func TestExtractAudioLevel_Valid(t *testing.T) {
	// Audio level 42 with V bit set (0x80 | 42 = 0xAA).
	pkt := buildRTPPacket(0, []struct{ id, value byte }{{1, 0x80 | 42}})
	level, ok := extractAudioLevel(pkt, len(pkt))
	if !ok {
		t.Fatal("expected ok=true for valid audio level extension")
	}
	if level != 42 {
		t.Fatalf("expected level=42, got %d", level)
	}
}

func TestExtractAudioLevel_NoExtension(t *testing.T) {
	// Packet without X bit (no extensions).
	pkt := buildRTPPacket(0, nil)
	_, ok := extractAudioLevel(pkt, len(pkt))
	if ok {
		t.Fatal("expected ok=false for packet without extension")
	}
}

func TestExtractAudioLevel_WrongExtensionID(t *testing.T) {
	// Extension with ID=5 instead of ID=1.
	pkt := buildRTPPacket(0, []struct{ id, value byte }{{5, 0x80 | 10}})
	_, ok := extractAudioLevel(pkt, len(pkt))
	if ok {
		t.Fatal("expected ok=false when extension ID does not match")
	}
}

func TestExtractAudioLevel_Truncated(t *testing.T) {
	// Too short to even contain the fixed header.
	_, ok := extractAudioLevel([]byte{0x90, 0x6F}, 2)
	if ok {
		t.Fatal("expected ok=false for truncated packet")
	}

	// Has X bit but truncated before extension header.
	pkt := buildRTPPacket(0, []struct{ id, value byte }{{1, 50}})
	_, ok = extractAudioLevel(pkt, 14) // cut off inside extension header
	if ok {
		t.Fatal("expected ok=false for packet truncated in extension header")
	}
}

func TestExtractAudioLevel_MultipleCSRCs(t *testing.T) {
	// 3 CSRCs, valid audio level extension.
	pkt := buildRTPPacket(3, []struct{ id, value byte }{{1, 0x80 | 99}})
	level, ok := extractAudioLevel(pkt, len(pkt))
	if !ok {
		t.Fatal("expected ok=true with CSRCs present")
	}
	if level != 99 {
		t.Fatalf("expected level=99, got %d", level)
	}
}

func TestExtractAudioLevel_MultipleExtensions(t *testing.T) {
	// Extension ID=3 first, then ID=1 (audio level).
	pkt := buildRTPPacket(0, []struct{ id, value byte }{
		{3, 0xFF},
		{1, 0x80 | 17},
	})
	level, ok := extractAudioLevel(pkt, len(pkt))
	if !ok {
		t.Fatal("expected ok=true when audio level is second extension")
	}
	if level != 17 {
		t.Fatalf("expected level=17, got %d", level)
	}
}

func TestExtractAudioLevel_VBitStripped(t *testing.T) {
	// Audio level 0 with V bit set — should return 0.
	pkt := buildRTPPacket(0, []struct{ id, value byte }{{1, 0x80}})
	level, ok := extractAudioLevel(pkt, len(pkt))
	if !ok {
		t.Fatal("expected ok=true")
	}
	if level != 0 {
		t.Fatalf("expected level=0, got %d", level)
	}
}

func TestExtractAudioLevel_NonBEDEProfile(t *testing.T) {
	// Manually construct a packet with X bit but non-0xBEDE profile.
	pkt := buildRTPPacket(0, []struct{ id, value byte }{{1, 50}})
	// Overwrite the profile field (bytes 12-13) with something else.
	binary.BigEndian.PutUint16(pkt[12:], 0x1000)
	_, ok := extractAudioLevel(pkt, len(pkt))
	if ok {
		t.Fatal("expected ok=false for non-BEDE profile")
	}
}
