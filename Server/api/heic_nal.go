package api

// heic_nal.go checks the coded pictures of a HEIC: the decoder
// configuration's sequence parameter sets and the NAL units of each image
// item, from their headers only.

import (
	"io"

	"github.com/gen2brain/h265/hevc"
)

type heicBudget struct {
	pixels int64  // coded pixels left over all images
	nals   int    // NAL units left to walk
	bytes  uint64 // item data bytes left, the file size to begin with
}

type bitReader struct {
	b   []byte
	pos int
	bad bool
}

func (r *bitReader) bit() uint32 {
	if r.pos>>3 >= len(r.b) {
		r.bad = true
		return 0
	}
	v := uint32(r.b[r.pos>>3]>>(7-uint(r.pos&7))) & 1
	r.pos++
	return v
}

func (r *bitReader) ue() uint32 {
	zeros := 0
	for r.bit() == 0 {
		if r.bad || zeros >= 31 {
			r.bad = true
			return 0
		}
		zeros++
	}
	var v uint32
	for range zeros {
		v = v<<1 | r.bit()
	}
	return v + (1 << zeros) - 1
}

// spsPixels is the coded size of a sequence parameter set, which must have no
// sub-layers (a still has none).
func spsPixels(nal []byte) (int64, error) {
	u, ok := hevc.ParseNAL(nal)
	if !ok || u.Type != hevc.NALSPS || u.LayerID != 0 || len(u.RBSP) < 14 || (u.RBSP[0]>>1)&7 != 0 {
		return 0, refuse("parameter set")
	}
	r := bitReader{b: u.RBSP[13:]} // after the id byte and profile_tier_level
	r.ue()                         // sps_seq_parameter_set_id
	if r.ue() == 3 {               // chroma_format_idc
		r.bit() // separate_colour_plane_flag
	}
	w, h := int64(r.ue()), int64(r.ue())
	if r.bad || w <= 0 || h <= 0 || w > 1<<16 || h > 1<<16 {
		return 0, refuse("parameter set size")
	}
	return w * h, nil
}

// parseHvcC reads the decoder configuration of a coded image: the size of the
// length prefix of its NAL units and the largest picture its parameter sets
// declare.
func parseHvcC(body []byte) (lengthSize uint64, pixels int64, err error) {
	if len(body) < 23 || body[0] != 1 {
		return 0, 0, refuse("decoder configuration")
	}
	lengthSize = uint64(body[21]&3) + 1
	arrays, rest := int(body[22]), body[23:]
	for range arrays {
		if len(rest) < 3 {
			return 0, 0, refuse("decoder configuration")
		}
		typ, n := hevc.NALType(rest[0]&0x3f), int(rest[1])<<8|int(rest[2])
		rest = rest[3:]
		for range n {
			if len(rest) < 2 {
				return 0, 0, refuse("decoder configuration")
			}
			l := int(rest[0])<<8 | int(rest[1])
			if len(rest) < 2+l {
				return 0, 0, refuse("decoder configuration")
			}
			if typ == hevc.NALSPS {
				p, err := spsPixels(rest[2 : 2+l])
				if err != nil {
					return 0, 0, err
				}
				pixels = max(pixels, p)
			}
			rest = rest[2+l:]
		}
	}
	if pixels == 0 {
		return 0, 0, refuse("no parameter set")
	}
	return lengthSize, pixels, nil
}

// checkCoded holds one coded image item to the layout: located inside the
// file, a decoder configuration whose pictures fit the budget, and item data
// that is exactly one picture of slice NAL units on the base layer.
func (m *heicMeta) checkCoded(r io.ReaderAt, id uint32, budget *heicBudget) error {
	cfg, found := m.property(id, "hvcC")
	ext, located := m.extents[id]
	if !found || !located || m.inIdat[id] {
		return refuse("coded image not locatable")
	}
	lengthSize, pixels, err := parseHvcC(cfg)
	if err != nil {
		return err
	}
	total := extentsTotal(ext)
	if pixels > heicMaxPixels || pixels > budget.pixels || total > budget.bytes {
		return refuse("coded images too large")
	}
	budget.pixels -= pixels
	budget.bytes -= total
	pictures, err := walkNALs(r, ext, lengthSize, budget)
	if err != nil {
		return err
	}
	if pictures != 1 {
		return refuse("coded image is not one picture")
	}
	return nil
}

// walkNALs walks the length-prefixed NAL units of an item's data and returns
// how many pictures start in it. Only slice segments of the base layer, access
// unit delimiters and SEI may appear.
func walkNALs(r io.ReaderAt, ext []heicExtent, lengthSize uint64, budget *heicBudget) (pictures int, err error) {
	total := extentsTotal(ext)
	var pos uint64
	for pos < total {
		if budget.nals == 0 {
			return 0, refuse("too many NAL units")
		}
		budget.nals--
		var lenBuf [4]byte
		if err := extentsAt(r, ext, pos, lenBuf[:lengthSize]); err != nil {
			return 0, err
		}
		var n uint64
		for _, c := range lenBuf[:lengthSize] {
			n = n<<8 | uint64(c)
		}
		pos += lengthSize
		if n < 3 || n > total-pos {
			return 0, refuse("NAL unit size")
		}
		var hdr [3]byte
		if err := extentsAt(r, ext, pos, hdr[:]); err != nil {
			return 0, err
		}
		starts, err := startsPicture(hdr[:])
		if err != nil {
			return 0, err
		}
		if starts {
			pictures++
		}
		pos += n
	}
	return pictures, nil
}

// startsPicture reports whether the NAL unit with this three-byte start is the
// first slice segment of a picture, and refuses what is not allowed.
func startsPicture(hdr []byte) (bool, error) {
	nal, ok := hevc.ParseNAL(hdr)
	if !ok || nal.LayerID != 0 {
		return false, refuse("NAL unit header")
	}
	switch {
	case nal.Type.IsVCL():
		// Slice segments of the base layer only; the reserved types are not slices.
		if (nal.Type > hevc.NALRaslR && nal.Type < hevc.NALBlaWLP) || nal.Type > hevc.NALCra {
			return false, refuse("NAL unit type")
		}
		return len(nal.RBSP) > 0 && nal.RBSP[0]&0x80 != 0, nil
	case nal.Type == hevc.NALAUD, nal.Type == hevc.NALPrefixSEI, nal.Type == hevc.NALSuffixSEI:
		return false, nil
	}
	return false, refuse("NAL unit type")
}
