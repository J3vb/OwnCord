package api_test

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/gen2brain/h265/heic"
	"golang.org/x/image/tiff"
)

// ftypHeader builds an ISO base media header: a size-prefixed ftyp box with a
// major brand and compatible brands, padded like the start of a real file.
func ftypHeader(major string, compat ...string) []byte {
	b := make([]byte, 8, 64)
	copy(b[4:], "ftyp")
	b = append(b, major...)
	b = append(b, 0, 0, 0, 0)
	for _, c := range compat {
		b = append(b, c...)
	}
	binary.BigEndian.PutUint32(b, uint32(len(b)))
	return append(b, make([]byte, 40)...)
}

func TestSniffMIME_ImageFormats(t *testing.T) {
	tests := []struct {
		name   string
		header []byte
		want   string
	}{
		{"iPhone HEIC", ftypHeader("heic", "mif1", "heic"), "image/heic"},
		{"heix", ftypHeader("heix"), "image/heic"},
		{"hevc brand", ftypHeader("hevc"), "image/heic"},
		{"mif1 major with a HEVC compatible brand", ftypHeader("mif1", "miaf", "heic"), "image/heic"},
		{"mif1 only is HEIF", ftypHeader("mif1", "miaf"), "image/heif"},
		{"msf1 only is HEIF", ftypHeader("msf1"), "image/heif"},
		{"AVIF is not HEIF", ftypHeader("avif", "mif1", "miaf"), "application/octet-stream"},
		{"QuickTime unchanged", ftypHeader("qt  "), "video/quicktime"},
		{"MP4 unchanged", ftypHeader("isom", "isom", "mp42"), "video/mp4"},
		{"TIFF little-endian", []byte("II*\x00\x08\x00\x00\x00"), "image/tiff"},
		{"TIFF big-endian", []byte("MM\x00*\x00\x00\x00\x08"), "image/tiff"},
		{"BigTIFF is not matched", []byte("II+\x00\x08\x00\x00\x00"), "application/octet-stream"},
		{"short header", []byte("ftyp"), "text/plain; charset=utf-8"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := api.SniffMIMEForTest(tt.header); got != tt.want {
				t.Errorf("sniffMIME = %q, want %q", got, tt.want)
			}
		})
	}
}

// testHEIC encodes a small solid-colour HEIC, w wide and h high as stored.
func testHEIC(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := heic.Encode(&buf, solidImage(w, h), heic.EncodeOptions{Quality: 60}); err != nil {
		t.Fatalf("heic.Encode: %v", err)
	}
	return buf.Bytes()
}

// withIrot turns the pixi property of an encoder-made HEIC (16 bytes, and
// nothing a decode needs) into an irot property of the same size, the way an
// iPhone portrait shot is stored sideways with a 90 degree rotation. The
// property is already associated with the primary item, and no offset moves.
func withIrot(t *testing.T, heicBytes []byte) []byte {
	t.Helper()
	out := bytes.Clone(heicBytes)
	i := bytes.Index(out, []byte("pixi"))
	if i < 4 || binary.BigEndian.Uint32(out[i-4:]) != 16 {
		t.Fatalf("the encoder's pixi box is not the expected 16 bytes")
	}
	copy(out[i:], "irot")
	copy(out[i+4:], make([]byte, 8))
	out[i+4] = 1 // 90 degrees anticlockwise
	return out
}

func testTIFF(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := tiff.Encode(&buf, solidImage(w, h), nil); err != nil {
		t.Fatalf("tiff.Encode: %v", err)
	}
	return buf.Bytes()
}

func uploadMeta(t *testing.T, router http.Handler, token, name string, content []byte) (mime string, w, h int) {
	t.Helper()
	_, mime, w, h = uploadFull(t, router, token, name, content)
	return mime, w, h
}

func uploadFull(t *testing.T, router http.Handler, token, name string, content []byte) (id, mime string, w, h int) {
	t.Helper()
	rr := doUpload(t, router, token, "file", name, content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload %s: %d; body: %s", name, rr.Code, rr.Body.String())
	}
	var resp struct {
		ID     string `json:"id"`
		Mime   string `json:"mime"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	return resp.ID, resp.Mime, resp.Width, resp.Height
}

func TestUpload_HEICStoresMimeAndUprightDimensions(t *testing.T) {
	database := newUploadTestDB(t)
	router := buildUploadRouter(database, newUploadTestStorage(t), nil)
	token := uploadCreateToken(t, database, "heicdims", 4)

	mime, w, h := uploadMeta(t, router, token, "land.heic", testHEIC(t, 64, 32))
	if mime != "image/heic" || w != 64 || h != 32 {
		t.Errorf("landscape HEIC: %s %dx%d, want image/heic 64x32", mime, w, h)
	}
	// Edge case 1: stored landscape, irot 90 -> upright portrait.
	mime, w, h = uploadMeta(t, router, token, "port.heic", withIrot(t, testHEIC(t, 64, 32)))
	if mime != "image/heic" || w != 32 || h != 64 {
		t.Errorf("portrait HEIC: %s %dx%d, want image/heic 32x64 (upright)", mime, w, h)
	}
}

func TestUpload_TIFFStoresMimeAndDimensions(t *testing.T) {
	database := newUploadTestDB(t)
	router := buildUploadRouter(database, newUploadTestStorage(t), nil)
	token := uploadCreateToken(t, database, "tiffdims", 4)
	mime, w, h := uploadMeta(t, router, token, "scan.tiff", testTIFF(t, 40, 20))
	if mime != "image/tiff" || w != 40 || h != 20 {
		t.Errorf("TIFF: %s %dx%d, want image/tiff 40x20", mime, w, h)
	}
}

func assertPreviewJPEG(t *testing.T, rr *httptest.ResponseRecorder, wantW, wantH int) {
	t.Helper()
	body := rr.Body.Bytes()
	if rr.Code != http.StatusOK {
		t.Fatalf("preview: %d, want 200", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("Content-Type = %q, want image/jpeg", ct)
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil || format != "jpeg" || cfg.Width != wantW || cfg.Height != wantH {
		t.Fatalf("preview = %dx%d %s (%v), want a %dx%d JPEG", cfg.Width, cfg.Height, format, err, wantW, wantH)
	}
	if _, err := jpeg.Decode(bytes.NewReader(body)); err != nil {
		t.Fatalf("preview does not decode: %v", err)
	}
}

func TestServeThumb_HEICIsAJPEGEvenInsideTheBox(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbheic", 4)
	original := testHEIC(t, 64, 32)
	id := uploadForThumb(t, router, token, "a.heic", original)

	rr := doServeThumb(t, router, id, token)
	assertPreviewJPEG(t, rr, 64, 32) // not enlarged
	first := bytes.Clone(rr.Body.Bytes())

	kept, err := store.OpenThumb(id)
	if err != nil {
		t.Fatalf("the preview was not kept: %v", err)
	}
	defer kept.Close() //nolint:errcheck
	if info, err := kept.Stat(); err != nil || info.Size() == 0 {
		t.Fatalf("kept preview: %v, %v", info, err)
	}

	// The second request is served from the kept preview, with the same type.
	rr = doServeThumb(t, router, id, token)
	assertPreviewJPEG(t, rr, 64, 32)
	if !bytes.Equal(rr.Body.Bytes(), first) {
		t.Error("second request was not served from the kept preview")
	}
	// Download still gives the original, as stored.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/files/"+id, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	dl := httptest.NewRecorder()
	router.ServeHTTP(dl, req)
	if dl.Code != http.StatusOK || !bytes.Equal(dl.Body.Bytes(), original) || dl.Header().Get("Content-Type") != "image/heic" {
		t.Errorf("download: %d %q, %d bytes; want the original image/heic", dl.Code, dl.Header().Get("Content-Type"), dl.Body.Len())
	}
}

func TestServeThumb_PortraitHEICPreviewIsUpright(t *testing.T) {
	database := newUploadTestDB(t)
	router := buildUploadRouter(database, newUploadTestStorage(t), nil)
	token := uploadCreateToken(t, database, "thumbirot", 4)
	id := uploadForThumb(t, router, token, "p.heic", withIrot(t, testHEIC(t, 64, 32)))
	rr := doServeThumb(t, router, id, token)
	assertPreviewJPEG(t, rr, 32, 64)
}

func TestServeThumb_LargeHEICIsScaledIntoTheBox(t *testing.T) {
	database := newUploadTestDB(t)
	router := buildUploadRouter(database, newUploadTestStorage(t), nil)
	token := uploadCreateToken(t, database, "thumbbigheic", 4)
	id := uploadForThumb(t, router, token, "big.heic", testHEIC(t, 1600, 800))
	rr := doServeThumb(t, router, id, token)
	assertPreviewJPEG(t, rr, 800, 400)
}

func TestServeThumb_TIFFIsAJPEG(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbtiff", 4)
	id := uploadForThumb(t, router, token, "a.tif", testTIFF(t, 50, 30))
	rr := doServeThumb(t, router, id, token)
	assertPreviewJPEG(t, rr, 50, 30)
	rr = doServeThumb(t, router, id, token) // from the kept preview
	assertPreviewJPEG(t, rr, 50, 30)
}

// patchedISPE rewrites the declared size of an encoder-made HEIC.
func patchedISPE(t *testing.T, heicBytes []byte, w, h uint32) []byte {
	t.Helper()
	out := bytes.Clone(heicBytes)
	i := bytes.Index(out, []byte("ispe"))
	if i < 0 {
		t.Fatal("no ispe box")
	}
	binary.BigEndian.PutUint32(out[i+8:], w)
	binary.BigEndian.PutUint32(out[i+12:], h)
	return out
}

// Edge case 2: a corrupt or oversized HEIC/TIFF is a 404 once, the failure is
// kept as an empty preview, it is never decoded again, and the raw bytes are
// never served as an image.
func TestServeThumb_UnconvertibleImageIs404OnceAndNeverRetried(t *testing.T) {
	good := testHEIC(t, 64, 32)
	tiffGood := testTIFF(t, 50, 30)
	cases := []struct {
		name, file string
		content    []byte
	}{
		{"truncated HEIC", "bad.heic", good[:len(good)/2]},
		{"HEIC header with garbage", "junk.heic", append(ftypHeader("heic", "mif1"), bytes.Repeat([]byte{0xAB}, 300)...)},
		{"oversized HEIC", "huge.heic", patchedISPE(t, good, 12000, 12000)},
		{"sequence-only HEIC", "seq.heic", sequenceOnlyHEIC(t, 3)},
		{"HEIC primary item with several pictures", "multi.heic", multiPictureHEIC(t, 3)},
		{"truncated TIFF", "bad.tif", tiffGood[:len(tiffGood)/2]},
		{"TIFF header with garbage", "junk.tif", append([]byte("II*\x00\x08\x00\x00\x00"), bytes.Repeat([]byte{0xFF}, 100)...)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			database := newUploadTestDB(t)
			dir := t.TempDir()
			store, err := storage.New(dir, 10)
			if err != nil {
				t.Fatalf("storage.New: %v", err)
			}
			router := buildUploadRouter(database, store, nil)
			token := uploadCreateToken(t, database, "thumbbad", 4)
			id := uploadForThumb(t, router, token, tc.file, tc.content)

			rr := doServeThumb(t, router, id, token)
			if rr.Code != http.StatusNotFound {
				t.Fatalf("first request: %d, want 404", rr.Code)
			}
			if bytes.Contains(rr.Body.Bytes(), tc.content[:16]) {
				t.Error("the raw original was served")
			}
			marker, err := store.OpenThumb(id)
			if err != nil {
				t.Fatalf("the failure was not kept: %v", err)
			}
			info, err := marker.Stat()
			_ = marker.Close()
			if err != nil || info.Size() != 0 {
				t.Fatalf("kept marker = %v, %v, want an empty file", info, err)
			}

			// Swap in an original that would convert: the kept marker must
			// still answer 404 without a second decode.
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			for _, e := range entries {
				if e.Type().IsRegular() {
					replacement := good
					if filepath.Ext(tc.file) == ".tif" {
						replacement = tiffGood
					}
					if err := os.WriteFile(filepath.Join(dir, e.Name()), replacement, 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}
			rr = doServeThumb(t, router, id, token)
			if rr.Code != http.StatusNotFound {
				t.Errorf("second request: %d, want 404 from the kept marker", rr.Code)
			}
		})
	}
}

func isoBox(typ string, parts ...[]byte) []byte {
	n := 8
	for _, p := range parts {
		n += len(p)
	}
	out := binary.BigEndian.AppendUint32(nil, uint32(n))
	out = append(out, typ...)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func be32(v uint32) []byte { return binary.BigEndian.AppendUint32(nil, v) }

// boxOf returns the whole first box of the given type found in b.
func boxOf(t *testing.T, b []byte, typ string) []byte {
	t.Helper()
	i := bytes.Index(b, []byte(typ))
	if i < 4 {
		t.Fatalf("no %s box", typ)
	}
	return b[i-4 : i-4+int(binary.BigEndian.Uint32(b[i-4:]))]
}

// sequenceOnlyHEIC is a file with the msf1 and hevc brands that holds an image
// sequence track of n frames and no primary item.
func sequenceOnlyHEIC(t *testing.T, n int) []byte {
	t.Helper()
	still := testHEIC(t, 16, 16)
	hvcC := boxOf(t, still, "hvcC")
	data := boxOf(t, still, "mdat")[8:]
	ftyp := isoBox("ftyp", []byte("msf1"), be32(0), []byte("msf1hevciso8"))
	entry := make([]byte, 78)
	binary.BigEndian.PutUint16(entry[6:], 1)
	binary.BigEndian.PutUint16(entry[24:], 16)
	binary.BigEndian.PutUint16(entry[26:], 16)
	var sizes []byte
	for range n {
		sizes = append(sizes, be32(uint32(len(data)))...)
	}
	build := func(off uint32) []byte {
		var offs []byte
		for range n {
			offs = append(offs, be32(off)...)
		}
		stbl := isoBox("stbl",
			isoBox("stsd", be32(0), be32(1), isoBox("hvc1", entry, hvcC)),
			isoBox("stts", be32(0), be32(1), be32(uint32(n)), be32(1)),
			isoBox("stsz", be32(0), be32(0), be32(uint32(n)), sizes),
			isoBox("stsc", be32(0), be32(1), be32(1), be32(1), be32(1)),
			isoBox("stco", be32(0), be32(uint32(n)), offs))
		hdlr := isoBox("hdlr", be32(0), be32(0), []byte("pict"), make([]byte, 13))
		mdhd := isoBox("mdhd", be32(0), be32(0), be32(0), be32(1000), be32(0), be32(0))
		tkhd := isoBox("tkhd", be32(0), be32(0), be32(0), be32(1), be32(0), be32(0), make([]byte, 60))
		trak := isoBox("trak", tkhd, isoBox("mdia", mdhd, hdlr, isoBox("minf", stbl)))
		return append(bytes.Clone(ftyp), isoBox("moov", trak)...)
	}
	head := build(0)
	return append(build(uint32(len(head)+8)), isoBox("mdat", data)...)
}

// multiPictureHEIC is a still whose primary item's data holds n coded pictures
// in a row, with its iloc extent length widened to match.
func multiPictureHEIC(t *testing.T, n int) []byte {
	t.Helper()
	still := testHEIC(t, 16, 16)
	mdat := boxOf(t, still, "mdat")
	start := bytes.Index(still, mdat)
	rep := bytes.Repeat(mdat[8:], n)
	out := append(bytes.Clone(still[:start]), isoBox("mdat", rep)...)
	// The single extent's length is the last four bytes of the iloc entry.
	iloc := boxOf(t, out, "iloc")
	at := bytes.Index(out, iloc) + len(iloc) - 4
	if got := binary.BigEndian.Uint32(out[at:]); int(got) != len(mdat)-8 {
		t.Fatalf("iloc layout differs: extent length %d, want %d", got, len(mdat)-8)
	}
	binary.BigEndian.PutUint32(out[at:], uint32(len(rep)))
	return out
}

func TestServeThumb_ThePlainStillStillConverts(t *testing.T) {
	// The fixtures above are variations of this file: it must pass the check.
	database := newUploadTestDB(t)
	router := buildUploadRouter(database, newUploadTestStorage(t), nil)
	token := uploadCreateToken(t, database, "thumbplain", 4)
	id := uploadForThumb(t, router, token, "ok.heic", testHEIC(t, 16, 16))
	rr := doServeThumb(t, router, id, token)
	assertPreviewJPEG(t, rr, 16, 16)
}

// A HEIC whose major brand is not an HEVC one but lists one as compatible is
// still a HEIC: it gets its dimensions and its preview.
func TestUpload_HEICWithAHEVCCompatibleBrand(t *testing.T) {
	data := testHEIC(t, 64, 32)
	copy(data[8:12], "miaf") // major brand; the compatible brands keep heic
	database := newUploadTestDB(t)
	router := buildUploadRouter(database, newUploadTestStorage(t), nil)
	token := uploadCreateToken(t, database, "heicmiaf", 4)
	mime, w, h := uploadMeta(t, router, token, "m.heic", data)
	if mime != "image/heic" || w != 64 || h != 32 {
		t.Fatalf("%s %dx%d, want image/heic 64x32", mime, w, h)
	}
	id := uploadForThumb(t, router, token, "m2.heic", data)
	rr := doServeThumb(t, router, id, token)
	assertPreviewJPEG(t, rr, 64, 32)
}

// tiffWithTags is a tiny little-endian TIFF header and first directory with
// the given SHORT tag values, and no image data.
func tiffWithTags(first8 []byte, tags [][2]uint16) []byte {
	b := append([]byte("II*\x00"), 8, 0, 0, 0)
	if first8 != nil {
		b = append(b[:0], first8...)
	}
	b = binary.LittleEndian.AppendUint16(b, uint16(len(tags)))
	for _, tg := range tags {
		b = binary.LittleEndian.AppendUint16(b, tg[0])
		b = binary.LittleEndian.AppendUint16(b, 3) // SHORT
		b = binary.LittleEndian.AppendUint32(b, 1)
		b = binary.LittleEndian.AppendUint16(b, tg[1])
		b = append(b, 0, 0)
	}
	return append(b, make([]byte, 4)...)
}

func TestUpload_CameraRAWStaysAFile(t *testing.T) {
	cr2 := append([]byte("II*\x00\x10\x00\x00\x00CR\x02\x00"), 0, 0, 0, 0)
	cases := []struct {
		name, file string
		content    []byte
		want       string
	}{
		{"DNG version tag", "a.dng", tiffWithTags(nil, [][2]uint16{{0x0100, 8}, {0x0101, 8}, {0xC612, 1}}), "application/octet-stream"},
		{"Canon CR2 marker", "a.cr2", tiffWithTags(cr2, [][2]uint16{{0x0100, 8}}), "application/octet-stream"},
		{"NEF-style SubIFDs", "a.nef", tiffWithTags(nil, [][2]uint16{{0x0100, 8}, {0x0103, 1}, {0x014A, 1}}), "application/octet-stream"},
		{"reduced-resolution first image", "a.tif", tiffWithTags(nil, [][2]uint16{{0x00FE, 1}, {0x0103, 1}}), "application/octet-stream"},
		{"old-style JPEG compression", "a.arw", tiffWithTags(nil, [][2]uint16{{0x0103, 7}}), "application/octet-stream"},
		{"scanner page (NewSubfileType page bit only)", "a.tif", tiffWithTags(nil, [][2]uint16{{0x00FE, 2}, {0x0100, 8}, {0x0101, 8}, {0x0103, 1}}), "image/tiff"},
		{"plain TIFF directory", "a.tif", tiffWithTags(nil, [][2]uint16{{0x0100, 8}, {0x0101, 8}, {0x0103, 1}}), "image/tiff"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			database := newUploadTestDB(t)
			router := buildUploadRouter(database, newUploadTestStorage(t), nil)
			token := uploadCreateToken(t, database, "rawfile", 4)
			if mime, _, _ := uploadMeta(t, router, token, tc.file, tc.content); mime != tc.want {
				t.Errorf("mime = %q, want %q", mime, tc.want)
			}
		})
	}
}
