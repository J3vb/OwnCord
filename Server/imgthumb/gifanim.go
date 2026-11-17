package imgthumb

import (
	"bufio"
	"io"
)

// GIFAnimated reports whether r holds a GIF of more than one frame. It walks the block structure and
// stops at the second image, decoding no pixels, so it costs one pass over the first frame at most. A
// stream that is not a GIF, or ends early, is not animated.
func GIFAnimated(r io.Reader) bool {
	br := bufio.NewReader(r)
	var head [13]byte
	if _, err := io.ReadFull(br, head[:]); err != nil || (string(head[:6]) != "GIF87a" && string(head[:6]) != "GIF89a") {
		return false
	}
	if !skipColorTable(br, head[10]) {
		return false
	}
	frames := 0
	for {
		intro, err := br.ReadByte()
		if err != nil {
			return false
		}
		switch intro {
		case 0x21: // extension: a label, then data sub-blocks
			if _, err := br.ReadByte(); err != nil || !skipSubBlocks(br) {
				return false
			}
		case 0x2C: // image descriptor
			var desc [9]byte
			if _, err := io.ReadFull(br, desc[:]); err != nil || !skipColorTable(br, desc[8]) {
				return false
			}
			if _, err := br.ReadByte(); err != nil || !skipSubBlocks(br) { // LZW minimum code size, then data
				return false
			}
			if frames++; frames > 1 {
				return true
			}
		default: // trailer or garbage
			return false
		}
	}
}

// skipColorTable discards the color table a descriptor's flags byte announces, if any.
func skipColorTable(br *bufio.Reader, flags byte) bool {
	if flags&0x80 == 0 {
		return true
	}
	_, err := br.Discard(3 << (uint(flags&0x07) + 1))
	return err == nil
}

// skipSubBlocks discards length-prefixed sub-blocks up to and including the zero-length terminator.
func skipSubBlocks(br *bufio.Reader) bool {
	for {
		n, err := br.ReadByte()
		if err != nil {
			return false
		}
		if n == 0 {
			return true
		}
		if _, err := br.Discard(int(n)); err != nil {
			return false
		}
	}
}
