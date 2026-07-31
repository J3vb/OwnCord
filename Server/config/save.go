package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/structs"
	"github.com/knadh/koanf/v2"
	goyaml "go.yaml.in/yaml/v3"
)

// DefaultPath is the CWD-relative config file path the server loads at
// startup. Shared by main.go, token_cli.go and the setup wizard so they can
// never disagree about which file is authoritative.
const DefaultPath = "config.yaml"

// Patch lists the config.yaml keys the first-run setup wizard may change.
// A nil field leaves the file's current value untouched.
type Patch struct {
	ServerPort      *int
	ServerName      *string
	TLSMode         *string // self_signed | acme | manual | off
	TLSDomain       *string
	UploadMaxSizeMB *int
	VoiceQuality    *string // low | medium | high

	// VoiceAPIKey/VoiceAPISecret are written ONLY when the file's
	// corresponding value is absent or empty. This persists the
	// runtime-generated LiveKit credentials (see applyVoiceDefaults) so voice
	// tokens survive restarts, without ever clobbering operator-set values.
	VoiceAPIKey    *string
	VoiceAPISecret *string
}

// saveMu serialises Save calls so concurrent writers cannot interleave the
// read-modify-write cycle.
var saveMu sync.Mutex

// Save patches the config file at path with the non-nil fields of p,
// preserving comments, key order, hand edits and keys it does not model.
// The write is atomic (temp file + rename) and the result is verified to
// parse and unmarshal before it replaces the original — Save never leaves
// behind a file the server would refuse to boot from.
func Save(path string, p Patch) error {
	saveMu.Lock()
	defer saveMu.Unlock()

	raw, err := os.ReadFile(path) //nolint:gosec // G304: path comes from trusted wiring, not request input
	if errors.Is(err, os.ErrNotExist) {
		// File deleted since startup — start from the shipped template so the
		// documentation comments still end up in the patched file.
		raw = []byte(defaultYAML)
	} else if err != nil {
		return fmt.Errorf("reading config file %s: %w", path, err)
	}

	var doc goyaml.Node
	if err := goyaml.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("parsing config file %s: %w", path, err)
	}
	root, err := mappingRoot(&doc)
	if err != nil {
		return fmt.Errorf("config file %s: %w", path, err)
	}

	applyPatch(root, p)

	var buf bytes.Buffer
	enc := goyaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return fmt.Errorf("encoding config: %w", err)
	}
	if err := enc.Close(); err != nil {
		return fmt.Errorf("encoding config: %w", err)
	}

	// Sanity gate: the buffer must survive the same parse+unmarshal path Load
	// uses. A bug here must fail the request, never brick the server's boot.
	if err := verifyLoadable(buf.Bytes()); err != nil {
		return fmt.Errorf("refusing to write config that would not load: %w", err)
	}

	return atomicWrite(path, buf.Bytes())
}

// applyPatch upserts every non-nil Patch field into the document root.
func applyPatch(root *goyaml.Node, p Patch) {
	if p.ServerPort != nil {
		setScalar(section(root, "server"), "port", strconv.Itoa(*p.ServerPort), "!!int")
	}
	if p.ServerName != nil {
		setScalar(section(root, "server"), "name", *p.ServerName, "!!str")
	}
	if p.TLSMode != nil {
		setScalar(section(root, "tls"), "mode", *p.TLSMode, "!!str")
	}
	if p.TLSDomain != nil {
		setScalar(section(root, "tls"), "domain", *p.TLSDomain, "!!str")
	}
	if p.UploadMaxSizeMB != nil {
		setScalar(section(root, "upload"), "max_size_mb", strconv.Itoa(*p.UploadMaxSizeMB), "!!int")
	}
	if p.VoiceQuality != nil {
		setScalar(section(root, "voice"), "quality", *p.VoiceQuality, "!!str")
	}
	if p.VoiceAPIKey != nil {
		if cur := findValue(section(root, "voice"), "livekit_api_key"); cur == nil || cur.Value == "" {
			setScalar(section(root, "voice"), "livekit_api_key", *p.VoiceAPIKey, "!!str")
		}
	}
	if p.VoiceAPISecret != nil {
		if cur := findValue(section(root, "voice"), "livekit_api_secret"); cur == nil || cur.Value == "" {
			setScalar(section(root, "voice"), "livekit_api_secret", *p.VoiceAPISecret, "!!str")
		}
	}
}

// mappingRoot returns the top-level mapping of the parsed document, creating
// an empty document+mapping when the file was empty or comments-only.
func mappingRoot(doc *goyaml.Node) (*goyaml.Node, error) {
	if doc.Kind == 0 {
		doc.Kind = goyaml.DocumentNode
	}
	if len(doc.Content) == 0 {
		m := &goyaml.Node{Kind: goyaml.MappingNode, Tag: "!!map"}
		doc.Content = []*goyaml.Node{m}
		return m, nil
	}
	root := doc.Content[0]
	// A document holding only a null scalar (e.g. a file with nothing but
	// comments) can be promoted to a mapping in place, keeping its comments.
	if root.Kind == goyaml.ScalarNode && root.Tag == "!!null" {
		root.Kind = goyaml.MappingNode
		root.Tag = "!!map"
		root.Value = ""
		return root, nil
	}
	if root.Kind != goyaml.MappingNode {
		return nil, errors.New("root is not a YAML mapping")
	}
	return root, nil
}

// section returns the mapping value node for a top-level section key,
// creating and appending the section when absent. A present-but-null section
// (e.g. bare "voice:" with all children commented out) is promoted to a
// mapping in place so its comments survive.
func section(root *goyaml.Node, name string) *goyaml.Node {
	if v := findValue(root, name); v != nil {
		if v.Kind != goyaml.MappingNode {
			v.Kind = goyaml.MappingNode
			v.Tag = "!!map"
			v.Value = ""
			v.Style = 0
			v.Content = nil
		}
		return v
	}
	k := &goyaml.Node{Kind: goyaml.ScalarNode, Tag: "!!str", Value: name}
	v := &goyaml.Node{Kind: goyaml.MappingNode, Tag: "!!map"}
	root.Content = append(root.Content, k, v)
	return v
}

// findValue returns the value node for key within a mapping node, or nil.
func findValue(m *goyaml.Node, key string) *goyaml.Node {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// setScalar upserts key: value inside the mapping node m. Values are set as
// node content, never spliced into text, so a value containing YAML syntax
// is encoded as one (quoted) scalar — injection is structurally impossible.
func setScalar(m *goyaml.Node, key, value, tag string) {
	if v := findValue(m, key); v != nil {
		v.Kind = goyaml.ScalarNode
		v.Tag = tag
		v.Value = value
		v.Style = 0 // let the encoder pick minimal correct quoting
		v.Content = nil
		return
	}
	m.Content = append(m.Content,
		&goyaml.Node{Kind: goyaml.ScalarNode, Tag: "!!str", Value: key},
		&goyaml.Node{Kind: goyaml.ScalarNode, Tag: tag, Value: value},
	)
}

// bytesProvider adapts a raw byte slice to koanf's Provider interface so the
// verification pass can reuse the exact YAML parser Load uses, without a
// temp file or an extra dependency.
type bytesProvider []byte

func (b bytesProvider) ReadBytes() ([]byte, error) { return b, nil }

func (b bytesProvider) Read() (map[string]any, error) {
	return nil, errors.New("bytesProvider requires a parser")
}

// verifyLoadable checks that raw would survive Load's parse+unmarshal path.
func verifyLoadable(raw []byte) error {
	if err := validateYAML(raw); err != nil {
		return err
	}
	k := koanf.New(".")
	if err := k.Load(structs.Provider(defaults(), "koanf"), nil); err != nil {
		return err
	}
	if err := k.Load(bytesProvider(raw), yaml.Parser()); err != nil {
		return err
	}
	var cfg Config
	return k.Unmarshal("", &cfg)
}

// atomicWrite replaces path with data via temp file + rename so a crash
// mid-write can never leave a truncated config. os.Rename replaces the
// destination on both Unix and Windows.
func atomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".config-*.yaml.tmp")
	if err != nil {
		return fmt.Errorf("creating temp config: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) //nolint:errcheck // no-op after successful rename

	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close() //nolint:errcheck,gosec // best-effort cleanup on error path
		return fmt.Errorf("setting temp config permissions: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close() //nolint:errcheck,gosec // best-effort cleanup on error path
		return fmt.Errorf("writing temp config: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close() //nolint:errcheck,gosec // best-effort cleanup on error path
		return fmt.Errorf("syncing temp config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing temp config: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replacing config file: %w", err)
	}
	return nil
}
