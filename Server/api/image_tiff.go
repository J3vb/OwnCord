package api

import (
	"encoding/binary"
	"io"
)

// tiffIFD0 reads the first IFD of the TIFF in r as tag to the first value
// field's low 16 bits, and whether the header and directory parsed.
func tiffIFD0(r io.ReaderAt) (tags map[uint16]uint32, ok bool) {
	var head [8]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return nil, false
	}
	var bo binary.ByteOrder
	switch string(head[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return nil, false
	}
	ifd := int64(bo.Uint32(head[4:]))
	var cnt [2]byte
	if _, err := r.ReadAt(cnt[:], ifd); err != nil {
		return nil, false
	}
	n := min(int(bo.Uint16(cnt[:])), tiffMaxIFDEntries)
	buf := make([]byte, n*12)
	if _, err := r.ReadAt(buf, ifd+2); err != nil {
		return nil, false
	}
	tags = make(map[uint16]uint32, n)
	for i := range n {
		e := buf[i*12:]
		if bo.Uint16(e[2:]) == 3 { // SHORT
			tags[bo.Uint16(e)] = uint32(bo.Uint16(e[8:]))
		} else {
			tags[bo.Uint16(e)] = bo.Uint32(e[8:])
		}
	}
	return tags, true
}

// tiffOrientation reads the Orientation tag (1-8, or 1 when absent or
// unreadable) from the first IFD of the TIFF in r.
func tiffOrientation(r io.ReaderAt) int {
	tags, ok := tiffIFD0(r)
	if o := int(tags[0x0112]); ok && o >= 1 && o <= 8 {
		return o
	}
	return 1
}

// isCameraRAW reports whether the TIFF-structured file in r is a camera RAW
// (DNG, NEF, CR2, ARW and the like) rather than a plain TIFF: those are not
// pictures a preview can be made of, so they stay a download. It looks for
// the DNGVersion tag, the Canon CR2 marker, SubIFDs or a reduced-resolution
// first image, and old-style JPEG compression in the first IFD, which the TIFF
// decoder does not read either.
func isCameraRAW(r io.ReaderAt) bool {
	var mark [2]byte
	if _, err := r.ReadAt(mark[:], 8); err == nil && string(mark[:]) == "CR" {
		return true
	}
	tags, ok := tiffIFD0(r)
	if !ok {
		return false
	}
	if _, dng := tags[0xC612]; dng {
		return true
	}
	// SubIFDs (NEF and others keep their raw data there) and a reduced-resolution
	// first image (NewSubfileType bit 0) are not in a plain scan.
	if _, sub := tags[0x014A]; sub || tags[0x00FE]&1 == 1 {
		return true
	}
	c := tags[0x0103]
	return c == 6 || c == 7
}
