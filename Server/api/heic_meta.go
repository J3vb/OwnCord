package api

// heic_meta.go decides whether a HEIC has the plain still-image layout that
// is converted: an allowlist of the file shape, checked before any HEIC
// decoder runs. Everything outside it is refused. The check walks the items
// the decoder reads for the primary image the way the decoder finds them (the
// primary, the tiles of a grid, and one alpha plane, which is a coded image, a
// grid of coded tiles, or one coded image per tile of a grid), holds every
// grid on that walk to its descriptor and every coded item on it to exactly
// one picture, all of them under one shared pixel, NAL unit and byte budget,
// and refuses a layout in which an item would be reached twice.

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
)

const (
	// heicMetaMaxBytes caps the meta box read to find its items and properties.
	heicMetaMaxBytes = 4 << 20
	// heicMaxItems, heicMaxTopBoxes, heicMaxProps and heicMaxExtents bound the
	// counts the file may declare.
	heicMaxItems    = 4096
	heicMaxTopBoxes = 64
	heicMaxProps    = 1024
	heicMaxExtents  = 64
	heicMaxTiles    = 1024
	// heicMaxAssoc bounds the property associations of one item.
	heicMaxAssoc = 64
)

func refuse(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errConvertRefused, fmt.Sprintf(format, args...))
}

type heicInfo struct {
	// quarterTurn is whether the primary image is shown a quarter turn from
	// how it is stored (irot of 90 or 270 degrees).
	quarterTurn bool
}

type isoBox struct {
	typ  string
	body []byte
}

// splitBoxes splits b into its boxes, strictly: every byte belongs to a box
// whose declared size fits, and there are at most limit of them.
func splitBoxes(b []byte, limit int) ([]isoBox, error) {
	var out []isoBox
	for len(b) > 0 {
		if len(b) < 8 || len(out) >= limit {
			return nil, refuse("malformed boxes")
		}
		size, hdr := uint64(binary.BigEndian.Uint32(b)), uint64(8)
		switch size {
		case 1:
			if len(b) < 16 {
				return nil, refuse("malformed boxes")
			}
			size, hdr = binary.BigEndian.Uint64(b[8:]), 16
		case 0:
			size = uint64(len(b))
		}
		if size < hdr || size > uint64(len(b)) {
			return nil, refuse("malformed boxes")
		}
		out = append(out, isoBox{typ: string(b[4:8]), body: b[hdr:size]})
		b = b[size:]
	}
	return out, nil
}

// heicTopLevel walks the top-level boxes of the size-byte file in r and
// returns the payload of its meta box. Only ftyp (first), meta, mdat, free and
// skip may appear: a movie, fragment or any other box is refused.
func heicTopLevel(r io.ReaderAt, size int64) (meta []byte, err error) {
	if size < 0 {
		return nil, refuse("negative size")
	}
	var pos uint64
	total := uint64(size)
	for n := 0; pos < total; n++ {
		if n >= heicMaxTopBoxes {
			return nil, refuse("too many boxes")
		}
		var hdr [16]byte
		got := min(uint64(len(hdr)), total-pos)
		if got < 8 {
			return nil, refuse("malformed boxes")
		}
		if _, err := r.ReadAt(hdr[:got], int64(pos)); err != nil { //nolint:gosec // pos <= size
			return nil, refuse("unreadable header")
		}
		boxSize, hdrLen := uint64(binary.BigEndian.Uint32(hdr[:])), uint64(8)
		switch boxSize {
		case 1:
			if got < 16 {
				return nil, refuse("malformed boxes")
			}
			boxSize, hdrLen = binary.BigEndian.Uint64(hdr[8:]), 16
		case 0:
			boxSize = total - pos
		}
		if boxSize < hdrLen || boxSize > total-pos {
			return nil, refuse("malformed boxes")
		}
		typ := string(hdr[4:8])
		if (n == 0) != (typ == "ftyp") {
			return nil, refuse("ftyp must be the first box")
		}
		switch typ {
		case "ftyp", "mdat", "free", "skip":
		case "meta":
			if meta != nil {
				return nil, refuse("several meta boxes")
			}
			payload := boxSize - hdrLen
			if payload > heicMetaMaxBytes {
				return nil, refuse("meta too large")
			}
			meta = make([]byte, payload)
			if payload > 0 {
				if _, err := r.ReadAt(meta, int64(pos+hdrLen)); err != nil { //nolint:gosec // bounded by size
					return nil, refuse("unreadable meta")
				}
			}
		default:
			return nil, refuse("box %q is not part of a still image", typ)
		}
		pos += boxSize
	}
	if meta == nil {
		return nil, refuse("no meta box")
	}
	return meta, nil
}

func (m *heicMeta) property(id uint32, typ string) (body []byte, ok bool) {
	for _, idx := range m.assoc[id] {
		if idx >= 1 && idx <= len(m.props) && m.props[idx-1].typ == typ {
			return m.props[idx-1].body, true
		}
	}
	return nil, false
}

var heicAllowedProps = map[string]bool{
	"ispe": true, "hvcC": true, "pixi": true, "auxC": true,
	"irot": true, "imir": true, "clap": true, "colr": true,
}

func (m *heicMeta) ispe(id uint32) (w, h uint64, ok bool) {
	body, found := m.property(id, "ispe")
	r := byteReader{b: body}
	r.skip(4)
	w, h = r.uint(4), r.uint(4)
	return w, h, found && !r.bad && w > 0 && h > 0
}

func extentsTotal(ext []heicExtent) uint64 {
	var total uint64
	for _, e := range ext {
		total += e.length
	}
	return total
}

// validateHEIC accepts only the plain still-image layout (see the file
// comment). It is the one check ahead of every HEIC decoder call, at upload
// and for the preview, and reads the headers and each NAL's first bytes but
// none of the picture data.
func validateHEIC(r io.ReaderAt, size int64) (heicInfo, error) {
	info, _, _, err := checkHEIC(r, size)
	return info, err
}

// checkHEIC is validateHEIC, also returning the parsed meta box and the items
// the decoder reads, which the tests compare with what the decoder does.
func checkHEIC(r io.ReaderAt, size int64) (heicInfo, *heicMeta, heicPlan, error) {
	if size < 16 {
		return heicInfo{}, nil, heicPlan{}, refuse("too short")
	}
	meta, err := heicTopLevel(r, size)
	if err != nil {
		return heicInfo{}, nil, heicPlan{}, err
	}
	m, err := parseHEICMeta(meta, uint64(size))
	if err != nil {
		return heicInfo{}, nil, heicPlan{}, err
	}
	plan, err := m.decodePlan()
	if err != nil {
		return heicInfo{}, nil, heicPlan{}, err
	}
	if err := m.checkPlan(r, plan, uint64(size)); err != nil {
		return heicInfo{}, nil, heicPlan{}, err
	}
	body, found := m.property(m.primary, "irot")
	return heicInfo{quarterTurn: found && len(body) >= 1 && body[0]&1 == 1}, m, plan, nil
}

// checkPlan holds every grid the decoder assembles to its descriptor, then
// every coded item it decodes to one picture, all under one shared budget.
func (m *heicMeta) checkPlan(r io.ReaderAt, plan heicPlan, size uint64) error {
	for _, id := range plan.grids {
		if err := m.checkItemProps(id); err != nil {
			return err
		}
		if err := m.checkGrid(r, id); err != nil {
			return err
		}
	}
	if len(plan.coded) == 0 {
		return refuse("no coded image")
	}
	budget := heicBudget{pixels: 2 * heicMaxPixels, nals: heicMaxNALs, bytes: size}
	for _, id := range plan.coded {
		if m.types[id] != "hvc1" {
			return refuse("unsupported item type")
		}
		if err := m.checkItemProps(id); err != nil {
			return err
		}
		if err := m.checkCoded(r, id, &budget); err != nil {
			return err
		}
	}
	return nil
}

// checkItemProps refuses an association of a coded image or grid to a
// property that does not exist or is not one of heicAllowedProps.
func (m *heicMeta) checkItemProps(id uint32) error {
	for _, idx := range m.assoc[id] {
		if idx == 0 {
			continue
		}
		if idx > len(m.props) || !heicAllowedProps[m.props[idx-1].typ] {
			return refuse("property outside the still-image set")
		}
	}
	return nil
}

// heicPlan is what the decoder reads for the primary image: the grids it
// assembles and the coded items it decodes. Every other item (Exif, XMP, a
// tone map, thumbnails, depth or gain maps, the alpha of an alpha plane) is
// never decoded, and the layout check does not look at it.
type heicPlan struct {
	grids []uint32
	coded []uint32
}

// decodePlan lists the items the decoder reads for the primary image, found
// the way it finds them: the primary, a grid's tiles, and the alpha plane,
// which is the alpha item of the primary (a coded image or a grid of coded
// tiles) or, for a grid with none, the alpha items of its tiles when every
// tile has one. A layout the decoder could read more than one way is refused:
// an item with several alpha items, a grid with alpha of its own and on its
// tiles, alpha on only some tiles, and an item reached twice.
func (m *heicMeta) decodePlan() (heicPlan, error) {
	if t := m.types[m.primary]; t != "hvc1" && t != "grid" {
		return heicPlan{}, refuse("primary item is not a coded still")
	}
	var plan heicPlan
	m.addImage(&plan, m.primary)
	alpha, err := m.alphaOf(m.primary)
	if err != nil {
		return heicPlan{}, err
	}
	tileAlpha, err := m.tileAlpha(m.primary)
	if err != nil {
		return heicPlan{}, err
	}
	switch {
	case alpha != 0 && len(tileAlpha) > 0:
		return heicPlan{}, refuse("alpha on a grid and on its tiles")
	case alpha != 0:
		if t := m.types[alpha]; t != "hvc1" && t != "grid" {
			return heicPlan{}, refuse("unsupported item type")
		}
		m.addImage(&plan, alpha)
	default:
		plan.coded = append(plan.coded, tileAlpha...)
	}
	if err := plan.distinct(); err != nil {
		return heicPlan{}, err
	}
	return plan, nil
}

// addImage adds an image item to the plan: a grid and its tiles, or else the
// item itself as a coded image (checkPlan refuses one of another type).
func (m *heicMeta) addImage(plan *heicPlan, id uint32) {
	if m.types[id] != "grid" {
		plan.coded = append(plan.coded, id)
		return
	}
	plan.grids = append(plan.grids, id)
	plan.coded = append(plan.coded, m.dimg[id]...)
}

// alphaOf is the item that carries id's alpha channel, or 0 when none does:
// an item auxiliary to id with an alpha auxC, whatever its own type. More
// than one is refused.
func (m *heicMeta) alphaOf(id uint32) (uint32, error) {
	var found uint32
	for _, a := range m.auxl {
		if a[1] != id || !m.isAlpha(a[0]) {
			continue
		}
		if found != 0 {
			return 0, refuse("several alpha planes")
		}
		found = a[0]
	}
	return found, nil
}

// tileAlpha lists the alpha items of a grid's tiles: none, or one for every
// tile.
func (m *heicMeta) tileAlpha(id uint32) ([]uint32, error) {
	if m.types[id] != "grid" {
		return nil, nil
	}
	tiles := m.dimg[id]
	out := make([]uint32, 0, len(tiles))
	for _, t := range tiles {
		a, err := m.alphaOf(t)
		if err != nil {
			return nil, err
		}
		if a != 0 {
			out = append(out, a)
		}
	}
	if len(out) != 0 && len(out) != len(tiles) {
		return nil, refuse("alpha on some tiles only")
	}
	return out, nil
}

// distinct refuses a plan that reaches an item twice, which the decoder would
// then decode twice.
func (p heicPlan) distinct() error {
	seen := make(map[uint32]bool, len(p.grids)+len(p.coded))
	for _, list := range [][]uint32{p.grids, p.coded} {
		for _, id := range list {
			if seen[id] {
				return refuse("an item reached twice")
			}
			seen[id] = true
		}
	}
	return nil
}

func (m *heicMeta) isAlpha(id uint32) bool {
	body, ok := m.property(id, "auxC")
	if !ok || len(body) < 5 {
		return false
	}
	urn, _, _ := bytes.Cut(body[4:], []byte{0})
	switch string(urn) {
	case "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha", "urn:mpeg:hevc:2015:auxid:1":
		return true
	}
	return false
}

func (m *heicMeta) checkGrid(r io.ReaderAt, id uint32) error {
	rows, cols, gw, gh, err := m.gridDescriptor(r, id)
	if err != nil {
		return err
	}
	tiles := m.dimg[id]
	if gw == 0 || gh == 0 || gw > 1<<16 || gh > 1<<16 || gw*gh > heicMaxPixels ||
		uint64(len(tiles)) != rows*cols || len(tiles) > heicMaxTiles {
		return refuse("grid size")
	}
	seen := make(map[uint32]bool, len(tiles))
	needW, needH := (gw+cols-1)/cols, (gh+rows-1)/rows
	for _, t := range tiles {
		w, h, ok := m.ispe(t)
		if seen[t] || m.types[t] != "hvc1" || !ok || w < needW || h < needH {
			return refuse("grid tiles")
		}
		seen[t] = true
	}
	return nil
}

// gridDescriptor reads a grid's descriptor: exactly 8 or 12 bytes, in the file
// body or, as phones write it, in the idat box (the extents are then offsets
// into that box's body, as the decoder reads them).
func (m *heicMeta) gridDescriptor(r io.ReaderAt, id uint32) (rows, cols, gw, gh uint64, err error) {
	ext, located := m.extents[id]
	total := extentsTotal(ext)
	if !located || (total != 8 && total != 12) {
		return 0, 0, 0, 0, refuse("grid descriptor")
	}
	var desc [12]byte
	if m.inIdat[id] {
		d := desc[:0]
		for _, e := range ext {
			d = append(d, m.idat[e.off:e.off+e.length]...)
		}
	} else if err := extentsAt(r, ext, 0, desc[:total]); err != nil {
		return 0, 0, 0, 0, err
	}
	rows, cols = uint64(desc[2])+1, uint64(desc[3])+1
	switch {
	case desc[0] != 0 || desc[1]&^1 != 0 || (desc[1]&1 == 1) != (total == 12):
		return 0, 0, 0, 0, refuse("grid descriptor")
	case total == 12:
		gw, gh = uint64(binary.BigEndian.Uint32(desc[4:])), uint64(binary.BigEndian.Uint32(desc[8:]))
	default:
		gw, gh = uint64(binary.BigEndian.Uint16(desc[4:])), uint64(binary.BigEndian.Uint16(desc[6:]))
	}
	return rows, cols, gw, gh, nil
}

// extentsAt reads len(buf) bytes at pos of the data the extents make up in
// turn; the bytes must lie in one extent.
func extentsAt(r io.ReaderAt, ext []heicExtent, pos uint64, buf []byte) error {
	for _, e := range ext {
		if pos >= e.length {
			pos -= e.length
			continue
		}
		if uint64(len(buf)) > e.length-pos {
			return refuse("item data layout")
		}
		if _, err := r.ReadAt(buf, int64(e.off+pos)); err != nil { //nolint:gosec // extents were checked against the file size
			return refuse("unreadable item data")
		}
		return nil
	}
	return refuse("item data layout")
}
