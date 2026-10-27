package api

// heic_boxes.go parses the boxes inside a HEIC's meta box strictly: a box it
// does not follow, a repeated item, or a count the bytes cannot hold is a
// refusal.

import (
	"math"
	"slices"
)

type heicExtent struct{ off, length uint64 }

// heicMeta is the parsed meta box.
type heicMeta struct {
	primary     uint32
	havePrimary bool
	types       map[uint32]string
	props       []isoBox
	assoc       map[uint32][]int // item to 1-based property indices
	extents     map[uint32][]heicExtent
	dimg        map[uint32][]uint32 // grid item to its tile items
	auxl        [][2]uint32         // auxiliary item, the item it is auxiliary to
	idat        []byte              // the body of the one idat box
	inIdat      map[uint32]bool     // items whose extents lie in idat (method 1)
	size        uint64              // the file's size
}

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

// id reads an item id of n (at most 4) bytes.
func (r *byteReader) id(n int) uint32 {
	v := r.uint(n)
	if n > 4 || v > math.MaxUint32 {
		r.bad = true
		return 0
	}
	return uint32(v)
}

func (r *byteReader) skip(n int) {
	if n < 0 || len(r.b) < n {
		r.bad = true
		return
	}
	r.b = r.b[n:]
}

// parseHEICMeta parses the meta box payload strictly: a box this does not
// follow, a repeated item, or a count the bytes cannot hold is a refusal.
func parseHEICMeta(meta []byte, size uint64) (*heicMeta, error) {
	if len(meta) < 4 {
		return nil, refuse("malformed meta")
	}
	boxes, err := splitBoxes(meta[4:], heicMaxItems) // meta is a full box
	if err != nil {
		return nil, err
	}
	m := &heicMeta{
		types: map[uint32]string{}, assoc: map[uint32][]int{},
		extents: map[uint32][]heicExtent{}, dimg: map[uint32][]uint32{},
		inIdat: map[uint32]bool{}, size: size,
	}
	seen := map[string]bool{}
	for _, b := range boxes {
		switch b.typ {
		case "pitm", "iinf", "iloc", "iprp", "iref", "idat":
			if seen[b.typ] {
				return nil, refuse("repeated %s box", b.typ)
			}
			seen[b.typ] = true
		}
		switch b.typ {
		case "pitm":
			err = m.parsePitm(b.body)
		case "iinf":
			err = m.parseIinf(b.body)
		case "iloc":
			err = m.parseIloc(b.body)
		case "iref":
			err = m.parseIref(b.body)
		case "idat":
			m.idat = b.body
		case "iprp":
			err = m.parseIprp(b.body)
		}
		if err != nil {
			return nil, err
		}
	}
	if !m.havePrimary {
		return nil, refuse("no primary item")
	}
	for id, in := range m.inIdat {
		if !in {
			continue
		}
		for _, e := range m.extents[id] {
			if e.off > uint64(len(m.idat)) || e.length > uint64(len(m.idat))-e.off {
				return nil, refuse("extent outside the idat box")
			}
		}
	}
	return m, nil
}

func (m *heicMeta) parsePitm(body []byte) error {
	r := byteReader{b: body}
	version := r.uint(1)
	r.skip(3)
	switch version {
	case 0:
		m.primary = r.id(2)
	case 1:
		m.primary = r.id(4)
	default:
		return refuse("pitm version")
	}
	m.havePrimary = !r.bad && len(r.b) == 0
	if !m.havePrimary {
		return refuse("malformed pitm")
	}
	return nil
}

func (m *heicMeta) parseIinf(body []byte) error {
	r := byteReader{b: body}
	version := r.uint(1)
	r.skip(3)
	var count uint64
	switch version {
	case 0:
		count = r.uint(2)
	case 1:
		count = r.uint(4)
	default:
		return refuse("iinf version")
	}
	if r.bad || count > heicMaxItems {
		return refuse("malformed iinf")
	}
	entries, err := splitBoxes(r.b, heicMaxItems)
	if err != nil || uint64(len(entries)) != count {
		return refuse("malformed iinf")
	}
	for _, b := range entries {
		e := byteReader{b: b.body}
		v := e.uint(1)
		e.skip(3)
		var id uint32
		switch v {
		case 2:
			id = e.id(2)
		case 3:
			id = e.id(4)
		default:
			return refuse("infe version")
		}
		e.skip(2) // protection index
		if b.typ != "infe" || e.bad || len(e.b) < 4 {
			return refuse("malformed infe")
		}
		if _, dup := m.types[id]; dup {
			return refuse("repeated item")
		}
		m.types[id] = string(e.b[:4])
	}
	return nil
}

// ilocSizes are the field sizes an iloc box declares, in bytes.
type ilocSizes struct {
	version                           uint64
	offset, length, base, index, idSz int
	// minItem is the least an item takes: id, data reference and extent count.
	minItem uint64
}

// readIlocSizes reads the iloc header up to the item count; only the sizes the
// layout allows are accepted, so no field can be zero-sized where it counts.
func readIlocSizes(r *byteReader) (ilocSizes, error) {
	version := r.uint(1)
	r.skip(3)
	if version > 2 {
		return ilocSizes{}, refuse("iloc version")
	}
	sizes := r.uint(1)
	z := ilocSizes{version: version, offset: int(sizes >> 4), length: int(sizes & 15), idSz: 2, minItem: 6}
	sizes = r.uint(1)
	z.base, z.index = int(sizes>>4), int(sizes&15)
	if version == 0 {
		z.index = 0
	}
	if version == 2 {
		z.idSz, z.minItem = 4, 8
	}
	if (z.offset != 4 && z.offset != 8) || (z.length != 4 && z.length != 8) ||
		(z.base != 0 && z.base != 4 && z.base != 8) ||
		(z.index != 0 && z.index != 4 && z.index != 8) {
		return ilocSizes{}, refuse("iloc field sizes")
	}
	return z, nil
}

func (m *heicMeta) parseIloc(body []byte) error {
	r := byteReader{b: body}
	z, err := readIlocSizes(&r)
	if err != nil {
		return err
	}
	count := r.uint(z.idSz)
	// Every item is at least id, data reference and extent count.
	if r.bad || count > heicMaxItems || count*z.minItem > uint64(len(r.b)) {
		return refuse("malformed iloc")
	}
	for range count {
		if err := m.parseIlocItem(&r, z); err != nil {
			return err
		}
	}
	if len(r.b) != 0 {
		return refuse("malformed iloc")
	}
	return nil
}

// parseIlocItem reads one item's location: the file body (method 0) or the
// idat box (method 1), one data reference, and its extents.
func (m *heicMeta) parseIlocItem(r *byteReader, z ilocSizes) error {
	id := r.id(z.idSz)
	method := uint64(0)
	if z.version >= 1 {
		method = r.uint(2) & 15
	}
	if method > 1 {
		return refuse("item data construction method")
	}
	if r.uint(2) != 0 {
		return refuse("item data in another file")
	}
	base := r.uint(z.base)
	n := r.uint(2)
	if r.bad || n == 0 || n > heicMaxExtents {
		return refuse("extent count")
	}
	if _, dup := m.extents[id]; dup {
		return refuse("repeated item")
	}
	ext := make([]heicExtent, 0, n)
	for range n {
		r.skip(z.index)
		off, length := r.uint(z.offset), r.uint(z.length)
		// Method 0 is an offset in the file; method 1 one in the idat body,
		// which is checked once that box is known.
		if r.bad || length == 0 || base+off < base || base+off+length < base+off ||
			(method == 0 && base+off+length > m.size) {
			return refuse("extent outside the file")
		}
		ext = append(ext, heicExtent{off: base + off, length: length})
	}
	m.extents[id] = ext
	m.inIdat[id] = method == 1
	return nil
}

func (m *heicMeta) parseIref(body []byte) error {
	r := byteReader{b: body}
	version := r.uint(1)
	r.skip(3)
	if version > 1 || r.bad {
		return refuse("iref version")
	}
	idSize := 2 + 2*int(version)
	refs, err := splitBoxes(r.b, heicMaxItems)
	if err != nil {
		return err
	}
	for _, b := range refs {
		e := byteReader{b: b.body}
		from := e.id(idSize)
		n := e.uint(2)
		if e.bad || n*uint64(idSize) != uint64(len(e.b)) {
			return refuse("malformed iref")
		}
		if b.typ == "auxl" && n >= 1 {
			m.auxl = append(m.auxl, [2]uint32{from, e.id(idSize)})
		}
		if b.typ != "dimg" {
			continue
		}
		if _, dup := m.dimg[from]; dup || n > heicMaxTiles {
			return refuse("tile list")
		}
		to := make([]uint32, 0, n)
		for range n {
			to = append(to, e.id(idSize))
		}
		m.dimg[from] = to
	}
	return nil
}

func (m *heicMeta) parseIprp(body []byte) error {
	boxes, err := splitBoxes(body, heicMaxItems)
	if err != nil {
		return err
	}
	var ipma []byte
	haveIpco, haveIpma := false, false
	for _, c := range boxes {
		switch c.typ {
		case "ipco":
			if haveIpco {
				return refuse("repeated ipco")
			}
			haveIpco = true
			if m.props, err = splitBoxes(c.body, heicMaxProps); err != nil {
				return err
			}
			// A uuid box is not a property the decoder numbers the same way.
			if slices.ContainsFunc(m.props, func(p isoBox) bool { return p.typ == "uuid" }) {
				return refuse("uuid property")
			}
		case "ipma":
			if haveIpma {
				return refuse("repeated ipma")
			}
			haveIpma, ipma = true, c.body
		}
	}
	if !haveIpma {
		return nil
	}
	return m.parseIpma(ipma)
}

func (m *heicMeta) parseIpma(body []byte) error {
	r := byteReader{b: body}
	version := r.uint(1)
	flags := r.uint(3)
	if version > 1 {
		return refuse("ipma version")
	}
	idSize, count := 2+2*int(version), r.uint(4)
	if r.bad || count > heicMaxItems || count*uint64(idSize+1) > uint64(len(r.b)) {
		return refuse("malformed ipma")
	}
	for range count {
		id := r.id(idSize)
		n := r.uint(1)
		if _, dup := m.assoc[id]; dup || n > heicMaxAssoc {
			return refuse("repeated item")
		}
		list := make([]int, 0, n)
		for range n {
			if flags&1 == 1 {
				list = append(list, int(r.uint(2)&0x7fff))
			} else {
				list = append(list, int(r.uint(1)&0x7f))
			}
		}
		if r.bad {
			return refuse("malformed ipma")
		}
		m.assoc[id] = list
	}
	if len(r.b) != 0 {
		return refuse("malformed ipma")
	}
	return nil
}
