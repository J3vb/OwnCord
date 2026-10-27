package api

// heic_meta.go decides whether a HEIC has the plain still-image layout that
// is converted: an allowlist of the file shape, checked before any HEIC
// decoder runs. Everything outside it is refused, so what the decoder is then
// handed is one primary picture (or one grid of single-picture tiles) of a
// bounded size, found where the boxes say it is.

import (
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

// refuse is a HEIC the converter does not take, for the reason given.
func refuse(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errConvertRefused, fmt.Sprintf(format, args...))
}

// heicInfo is what validateHEIC learns about an accepted file.
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
		if size == 1 {
			if len(b) < 16 {
				return nil, refuse("malformed boxes")
			}
			size, hdr = binary.BigEndian.Uint64(b[8:]), 16
		} else if size == 0 {
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
		if boxSize == 1 {
			if got < 16 {
				return nil, refuse("malformed boxes")
			}
			boxSize, hdrLen = binary.BigEndian.Uint64(hdr[8:]), 16
		} else if boxSize == 0 {
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

// property is the first property of item id of box type typ.
func (m *heicMeta) property(id uint32, typ string) (body []byte, ok bool) {
	for _, idx := range m.assoc[id] {
		if idx >= 1 && idx <= len(m.props) && m.props[idx-1].typ == typ {
			return m.props[idx-1].body, true
		}
	}
	return nil, false
}

// heicAllowedProps are the properties a coded image or grid may carry.
var heicAllowedProps = map[string]bool{
	"ispe": true, "hvcC": true, "pixi": true, "auxC": true,
	"irot": true, "imir": true, "clap": true, "colr": true,
}

// ispe is the displayed size an item declares.
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
	if size < 16 {
		return heicInfo{}, refuse("too short")
	}
	meta, err := heicTopLevel(r, size)
	if err != nil {
		return heicInfo{}, err
	}
	m, err := parseHEICMeta(meta, uint64(size))
	if err != nil {
		return heicInfo{}, err
	}
	if t := m.types[m.primary]; t != "hvc1" && t != "grid" {
		return heicInfo{}, refuse("primary item is not a coded still")
	}
	budget := heicBudget{pixels: 2 * heicMaxPixels, nals: heicMaxNALs, bytes: uint64(size)}
	coded := 0
	for id, t := range m.types {
		switch t {
		case "hvc2":
			return heicInfo{}, refuse("unsupported item type")
		case "hvc1", "grid":
			if err := m.checkItemProps(id); err != nil {
				return heicInfo{}, err
			}
		}
		if t == "hvc1" {
			coded++
			if err := m.checkCoded(r, id, &budget); err != nil {
				return heicInfo{}, err
			}
		}
	}
	if coded == 0 {
		return heicInfo{}, refuse("no coded image")
	}
	for id, t := range m.types {
		if t == "grid" {
			if err := m.checkGrid(r, id, &budget); err != nil {
				return heicInfo{}, err
			}
		}
	}
	if len(m.dimg) > 0 {
		for from := range m.dimg {
			if m.types[from] != "grid" {
				return heicInfo{}, refuse("tiles of a non-grid item")
			}
		}
	}
	if t := m.types[m.primary]; t == "grid" && len(m.dimg[m.primary]) == 0 {
		return heicInfo{}, refuse("grid without tiles")
	}
	body, found := m.property(m.primary, "irot")
	return heicInfo{quarterTurn: found && len(body) >= 1 && body[0]&1 == 1}, nil
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

// checkGrid reads a grid's descriptor and holds its tiles to it.
func (m *heicMeta) checkGrid(r io.ReaderAt, id uint32, budget *heicBudget) error {
	ext, located := m.extents[id]
	total := extentsTotal(ext)
	if !located || (total != 8 && total != 12) {
		return refuse("grid descriptor")
	}
	var desc [12]byte
	if err := extentsAt(r, ext, 0, desc[:total]); err != nil {
		return err
	}
	rows, cols := uint64(desc[2])+1, uint64(desc[3])+1
	var gw, gh uint64
	switch {
	case desc[0] != 0 || desc[1]&^1 != 0 || (desc[1]&1 == 1) != (total == 12):
		return refuse("grid descriptor")
	case total == 12:
		gw, gh = uint64(binary.BigEndian.Uint32(desc[4:])), uint64(binary.BigEndian.Uint32(desc[8:]))
	default:
		gw, gh = uint64(binary.BigEndian.Uint16(desc[4:])), uint64(binary.BigEndian.Uint16(desc[6:]))
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
