package api

// heic_meta.go reads the parts of a HEIC's ISO base media boxes that decide
// whether it is converted: its primary item, how its pictures are stored, and
// its rotation.

import (
	"encoding/binary"
	"fmt"
	"io"
	"math"

	"github.com/gen2brain/h265/hevc"
)

// byteReader reads big-endian fields from a box body; a short read sets bad.
type byteReader struct {
	b   []byte
	bad bool
}

func (r *byteReader) uint(n int) uint64 {
	if n < 0 || n > 8 || len(r.b) < n {
		r.bad = true
		return 0
	}
	var v uint64
	for _, c := range r.b[:n] {
		v = v<<8 | uint64(c)
	}
	r.b = r.b[n:]
	return v
}

func (r *byteReader) skip(n int) {
	if n < 0 || len(r.b) < n {
		r.bad = true
		return
	}
	r.b = r.b[n:]
}

type heicExtent struct{ off, length uint64 }

// heicMeta is what the checks need from a HEIC's meta box.
type heicMeta struct {
	primary     uint32
	havePrimary bool
	types       map[uint32]string
	props       []isoBox
	assoc       map[uint32][]int
	extents     map[uint32][]heicExtent // construction method 0 only
}

// readHEICMeta finds and parses the meta box of the file in r, which it reads
// from the current position; ok is false when there is none or it is not
// followable.
func readHEICMeta(r io.Reader) (m *heicMeta, ok bool) {
	var hdr [8]byte
	for range 64 {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return nil, false
		}
		size := uint64(binary.BigEndian.Uint32(hdr[:4]))
		skip := uint64(8)
		if size == 1 {
			var large [8]byte
			if _, err := io.ReadFull(r, large[:]); err != nil {
				return nil, false
			}
			size, skip = binary.BigEndian.Uint64(large[:]), 16
		}
		if size < skip {
			return nil, false
		}
		payload := size - skip
		if string(hdr[4:]) != "meta" {
			if _, err := io.CopyN(io.Discard, r, int64(min(payload, math.MaxInt64))); err != nil {
				return nil, false
			}
			continue
		}
		if payload > heicMetaMaxBytes {
			return nil, false
		}
		meta := make([]byte, payload)
		if _, err := io.ReadFull(r, meta); err != nil {
			return nil, false
		}
		return parseHEICMeta(meta)
	}
	return nil, false
}

func parseHEICMeta(meta []byte) (m *heicMeta, ok bool) {
	if len(meta) < 4 {
		return nil, false
	}
	m = &heicMeta{types: map[uint32]string{}, assoc: map[uint32][]int{}, extents: map[uint32][]heicExtent{}}
	var ipma, iloc []byte
	for _, b := range isoBoxes(meta[4:]) { // meta is a full box: version and flags first
		switch b.typ {
		case "pitm":
			r := byteReader{b: b.body}
			version := r.uint(1)
			r.skip(3)
			if version == 0 {
				m.primary = uint32(r.uint(2))
			} else {
				m.primary = uint32(r.uint(4))
			}
			m.havePrimary = !r.bad
		case "iinf":
			parseIinf(b.body, m)
		case "iloc":
			iloc = b.body
		case "iprp":
			for _, c := range isoBoxes(b.body) {
				switch c.typ {
				case "ipco":
					m.props = isoBoxes(c.body)
				case "ipma":
					ipma = c.body
				}
			}
		}
	}
	parseIpma(ipma, m)
	parseIloc(iloc, m)
	return m, true
}

func parseIinf(body []byte, m *heicMeta) {
	r := byteReader{b: body}
	version := r.uint(1)
	r.skip(3)
	if version == 0 {
		r.skip(2) // entry count; the infe boxes that follow are what is read
	} else {
		r.skip(4)
	}
	if r.bad {
		return
	}
	for _, b := range isoBoxes(r.b) {
		if b.typ != "infe" || len(m.types) >= heicMaxItems {
			continue
		}
		e := byteReader{b: b.body}
		v := e.uint(1)
		e.skip(3)
		var id uint64
		switch v {
		case 2:
			id = e.uint(2)
		case 3:
			id = e.uint(4)
		default:
			continue
		}
		e.skip(2) // protection index
		if t := e.b; !e.bad && len(t) >= 4 {
			m.types[uint32(id)] = string(t[:4])
		}
	}
}

func parseIpma(body []byte, m *heicMeta) {
	r := byteReader{b: body}
	version := r.uint(1)
	flags := r.uint(3)
	count := r.uint(4)
	for range min(count, heicMaxItems) {
		idSize := 2
		if version >= 1 {
			idSize = 4
		}
		id := uint32(r.uint(idSize))
		n := int(r.uint(1))
		for range n {
			var idx int
			if flags&1 == 1 {
				idx = int(r.uint(2) & 0x7fff)
			} else {
				idx = int(r.uint(1) & 0x7f)
			}
			if r.bad {
				return
			}
			m.assoc[id] = append(m.assoc[id], idx)
		}
		if r.bad {
			return
		}
	}
}

func parseIloc(body []byte, m *heicMeta) {
	r := byteReader{b: body}
	version := r.uint(1)
	r.skip(3)
	sizes := r.uint(1)
	offsetSize, lengthSize := int(sizes>>4), int(sizes&15)
	sizes = r.uint(1)
	baseSize, indexSize := int(sizes>>4), int(sizes&15)
	if version == 0 {
		indexSize = 0
	}
	var count uint64
	if version < 2 {
		count = r.uint(2)
	} else {
		count = r.uint(4)
	}
	for range min(count, heicMaxItems) {
		var id uint32
		if version < 2 {
			id = uint32(r.uint(2))
		} else {
			id = uint32(r.uint(4))
		}
		method := uint64(0)
		if version >= 1 {
			method = r.uint(2) & 15
		}
		r.skip(2) // data reference index
		base := r.uint(baseSize)
		n := r.uint(2)
		var ext []heicExtent
		for range n {
			r.skip(indexSize)
			off, length := r.uint(offsetSize), r.uint(lengthSize)
			if r.bad {
				return
			}
			ext = append(ext, heicExtent{off: base + off, length: length})
		}
		if r.bad {
			return
		}
		if method == 0 {
			m.extents[id] = ext
		}
	}
}

// property is the first property of item id with the box type typ.
func (m *heicMeta) property(id uint32, typ string) (body []byte, ok bool) {
	for _, idx := range m.assoc[id] {
		if idx >= 1 && idx <= len(m.props) && m.props[idx-1].typ == typ {
			return m.props[idx-1].body, true
		}
	}
	return nil, false
}

// heicQuarterTurn reports whether the primary image of the HEIC in r carries
// an irot property of 90 or 270 degrees. heic.DecodeConfig returns the stored
// size, before the rotation, and the package exposes nothing cheaper than a
// full decode, so the one property is read here. Anything it cannot follow
// counts as no rotation.
func heicQuarterTurn(r io.Reader) bool {
	m, ok := readHEICMeta(r)
	if !ok || !m.havePrimary {
		return false
	}
	body, found := m.property(m.primary, "irot")
	return found && len(body) >= 1 && body[0]&1 == 1
}

// extentsAt reads len(buf) bytes at pos of the data the extents make up in turn.
func extentsAt(r io.ReaderAt, ext []heicExtent, pos uint64, buf []byte) error {
	for _, e := range ext {
		if pos >= e.length {
			pos -= e.length
			continue
		}
		if uint64(len(buf)) > e.length-pos {
			return errConvertRefused // a read across extents is never needed: NAL headers are read whole
		}
		if _, err := r.ReadAt(buf, int64(e.off+pos)); err != nil { //nolint:gosec // bounded by the file size in ReadAt
			return fmt.Errorf("reading item data: %w", err)
		}
		return nil
	}
	return errConvertRefused
}

// heicPictures counts the coded pictures in an item's data: the slice segment
// NAL units that start one. It reads only each NAL's length and first bytes.
func heicPictures(r io.ReaderAt, ext []heicExtent, lengthSize int) (int, error) {
	var total uint64
	for _, e := range ext {
		total += e.length
	}
	pictures := 0
	var pos uint64
	for range heicMaxNALs {
		if pos >= total {
			return pictures, nil
		}
		var lenBuf [4]byte
		if err := extentsAt(r, ext, pos, lenBuf[:lengthSize]); err != nil {
			return 0, err
		}
		var n uint64
		for _, c := range lenBuf[:lengthSize] {
			n = n<<8 | uint64(c)
		}
		pos += uint64(lengthSize)
		if n < 3 || n > total-pos {
			return 0, errConvertRefused
		}
		var hdr [3]byte
		if err := extentsAt(r, ext, pos, hdr[:]); err != nil {
			return 0, err
		}
		nal, ok := hevc.ParseNAL(hdr[:])
		if !ok {
			return 0, errConvertRefused
		}
		if nal.Type.IsVCL() && nal.LayerID == 0 && len(nal.RBSP) > 0 && nal.RBSP[0]&0x80 != 0 {
			pictures++
			if pictures > 1 {
				return pictures, nil
			}
		}
		pos += n
	}
	return 0, errConvertRefused
}

// checkHEICStill refuses a HEIC that is not one still picture the decoder
// would take whole: its primary item must be a coded image (hvc1) or a grid of
// them, and every coded image holds exactly one picture. A file that only
// carries an image sequence track has no primary item and is refused.
func checkHEICStill(r readerAt) error {
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("%w: %w", errConvertRefused, err)
	}
	m, ok := readHEICMeta(r)
	if !ok || !m.havePrimary {
		return fmt.Errorf("%w: no primary image", errConvertRefused)
	}
	if t := m.types[m.primary]; t != "hvc1" && t != "grid" {
		return fmt.Errorf("%w: primary item is not a coded still", errConvertRefused)
	}
	coded := 0
	for id, t := range m.types {
		if t != "hvc1" {
			continue
		}
		coded++
		cfg, found := m.property(id, "hvcC")
		ext, located := m.extents[id]
		if !found || len(cfg) < 22 || !located {
			return fmt.Errorf("%w: coded image not locatable", errConvertRefused)
		}
		n, err := heicPictures(r, ext, int(cfg[21]&3)+1)
		if err != nil || n != 1 {
			return fmt.Errorf("%w: coded image is not one picture", errConvertRefused)
		}
	}
	if coded == 0 {
		return fmt.Errorf("%w: no coded image", errConvertRefused)
	}
	return nil
}
