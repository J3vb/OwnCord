package admin

import (
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/clientip"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/updater"
)

// guardContext is the state the host guards judge: the request (for its real
// client address), the running options, the configuration the next boot would
// run with, and the keys the PATCH names.
type guardContext struct {
	r       *http.Request
	opts    SetupOptions
	next    *config.Config
	changes map[string]any
}

func (g guardContext) has(key string) bool {
	_, ok := g.changes[key]
	return ok
}

func (g guardContext) anyOf(keys ...string) bool {
	for _, key := range keys {
		if g.has(key) {
			return true
		}
	}
	return false
}

// runConfigGuards checks the keys a PATCH names against host state that the
// config package cannot see, writing the refusal itself and returning false
// when a change must not be saved. The lock-out guard runs first and answers
// 409 LOCKOUT; every other refusal is 400 and names the offending key. All
// guards judge next (the configuration the next boot would run with), so a
// null reset that falls back to a narrower config.yaml value is caught too.
func runConfigGuards(w http.ResponseWriter, r *http.Request, opts SetupOptions, next *config.Config, changes map[string]any) bool {
	g := guardContext{r: r, opts: opts, next: next, changes: changes}
	return guardPerimeter(w, g) &&
		guardPort(w, g) &&
		guardTLS(w, g) &&
		guardDataPaths(w, g) &&
		guardLiveKitBinary(w, g)
}

// guardPerimeter refuses a perimeter change that would exclude the caller's own
// address from the admin panel. An empty allowlist is allowed: it switches the
// perimeter off and cannot lock anyone out.
func guardPerimeter(w http.ResponseWriter, g guardContext) bool {
	if !g.anyOf("server.admin_allowed_cidrs", "server.trusted_proxies") {
		return true
	}
	proxies := clientip.ParseCIDRList(g.next.Server.TrustedProxies)
	ip := clientip.Resolve(g.r, proxies)
	if len(g.next.Server.AdminAllowedCIDRs) > 0 &&
		!clientip.InNets(ip, clientip.ParseCIDRList(g.next.Server.AdminAllowedCIDRs)) {
		writeErr(w, http.StatusConflict, "LOCKOUT",
			"this change would exclude your address from the admin panel and lock you out; refusing to save it")
		return false
	}
	return true
}

// guardPort refuses a listen-port change that cannot bind. In a container the
// published port mapping fixes the port, so any change is refused.
func guardPort(w http.ResponseWriter, g guardContext) bool {
	if !g.has("server.port") || g.next.Server.Port == g.opts.RunningCfg.Server.Port {
		return true
	}
	if updater.RunningInContainer() {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST",
			"server.port cannot be changed from the panel in a container; the published port mapping fixes it")
		return false
	}
	ln, err := net.Listen("tcp", ":"+strconv.Itoa(g.next.Server.Port))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST",
			"server.port "+strconv.Itoa(g.next.Server.Port)+" is not available on this host")
		return false
	}
	_ = ln.Close()
	return true
}

// guardTLS refuses a TLS change that would leave the server unable to serve
// TLS. It checks the pair, the acme domain and port 80.
func guardTLS(w http.ResponseWriter, g guardContext) bool {
	if !g.anyOf("tls.mode", "tls.domain", "tls.cert_file", "tls.key_file") {
		return true
	}
	switch g.next.TLS.Mode {
	case "manual":
		return guardManualTLS(w, g)
	case "acme":
		return guardAcmeTLS(w, g)
	case "self_signed":
		return guardSelfSignedTLS(w, g)
	default:
		return true
	}
}

func guardManualTLS(w http.ResponseWriter, g guardContext) bool {
	cert, err := tls.LoadX509KeyPair(g.next.TLS.CertFile, g.next.TLS.KeyFile)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "tls.cert_file/tls.key_file: the pair does not load")
		return false
	}
	if len(cert.Certificate) == 0 {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "tls.cert_file does not hold a certificate")
		return false
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil || time.Now().After(leaf.NotAfter) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "tls.cert_file: the certificate is unreadable or expired")
		return false
	}
	return true
}

func guardAcmeTLS(w http.ResponseWriter, g guardContext) bool {
	if g.next.TLS.Domain == "" {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "tls.domain must be set for acme mode")
		return false
	}
	// The ACME challenge answers on port 80; only probe when the server is not
	// already in acme mode (it would be holding nothing on 80 between runs).
	if g.opts.RunningCfg.TLS.Mode == "acme" {
		return true
	}
	ln, err := net.Listen("tcp", ":80")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "tls.mode acme needs port 80 free for the ACME challenge")
		return false
	}
	_ = ln.Close()
	return true
}

func guardSelfSignedTLS(w http.ResponseWriter, g guardContext) bool {
	if fileExists(g.next.TLS.CertFile) && fileExists(g.next.TLS.KeyFile) {
		if _, err := tls.LoadX509KeyPair(g.next.TLS.CertFile, g.next.TLS.KeyFile); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "tls.cert_file/tls.key_file: the existing pair does not load")
			return false
		}
		return true
	}
	if !dirWritable(filepath.Dir(g.next.TLS.CertFile)) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "tls.cert_file: the certificate directory is not writable")
		return false
	}
	if !dirWritable(filepath.Dir(g.next.TLS.KeyFile)) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "tls.key_file: the key directory is not writable")
		return false
	}
	return true
}

// guardDataPaths checks the host paths a PATCH moves: the database must be an
// intact OwnCord database, the directories must exist and be writable, and in
// a container every path the server writes must live under data_dir.
func guardDataPaths(w http.ResponseWriter, g guardContext) bool {
	return guardDatabasePath(w, g) &&
		guardBackupDir(w, g) &&
		guardStorageDir(w, g) &&
		guardPluginsDir(w, g) &&
		guardAcmeCacheDir(w, g)
}

func guardBackupDir(w http.ResponseWriter, g guardContext) bool {
	if !g.has("backup.dir") {
		return true
	}
	dir := g.next.Backup.Dir
	if containerOutsideDataDir(g, dir, "backup.dir", w) {
		return false
	}
	if !dirExists(dir) || !dirWritable(dir) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "backup.dir must be an existing writable directory")
		return false
	}
	if pathWithin(dir, g.next.Upload.StorageDir) || pathWithin(dir, g.next.Plugins.Directory) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "backup.dir must not live inside the uploads or plugins directory")
		return false
	}
	return true
}

func guardStorageDir(w http.ResponseWriter, g guardContext) bool {
	if !g.has("upload.storage_dir") {
		return true
	}
	dir := g.next.Upload.StorageDir
	if containerOutsideDataDir(g, dir, "upload.storage_dir", w) {
		return false
	}
	if !dirExists(dir) || !dirWritable(dir) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "upload.storage_dir must be an existing writable directory")
		return false
	}
	if dirEmpty(dir) && !dirEmpty(g.opts.RunningCfg.Upload.StorageDir) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST",
			"upload.storage_dir is empty while the current directory holds files; copy the files first or every attachment returns 404")
		return false
	}
	return true
}

func guardPluginsDir(w http.ResponseWriter, g guardContext) bool {
	if !g.has("plugins.directory") {
		return true
	}
	dir := g.next.Plugins.Directory
	if !dirExists(dir) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "plugins.directory must be an existing directory")
		return false
	}
	if pathWithin(dir, g.next.Upload.StorageDir) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "plugins.directory must not live inside the uploads directory")
		return false
	}
	return true
}

func guardAcmeCacheDir(w http.ResponseWriter, g guardContext) bool {
	if !g.has("tls.acme_cache_dir") {
		return true
	}
	dir := g.next.TLS.AcmeCacheDir
	if containerOutsideDataDir(g, dir, "tls.acme_cache_dir", w) {
		return false
	}
	if info, err := os.Stat(dir); err == nil {
		if !info.IsDir() {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "tls.acme_cache_dir exists but is not a directory")
			return false
		}
		if dirWritable(dir) {
			return true
		}
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "tls.acme_cache_dir is not writable")
		return false
	}
	if dirWritable(filepath.Dir(dir)) {
		return true
	}
	writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "tls.acme_cache_dir does not exist and its parent is not writable")
	return false
}

// guardLiveKitBinary refuses a binary the server process could have written
// itself: an upload, a plugin or a backup. voice.livekit_binary is executed, so
// a stolen owner session must not be able to plant one and then run it.
func guardLiveKitBinary(w http.ResponseWriter, g guardContext) bool {
	if !g.has("voice.livekit_binary") {
		return true
	}
	path := g.next.Voice.LiveKitBinaryPath
	if path == "" {
		return true
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "voice.livekit_binary must name an existing regular file")
		return false
	}
	if info.Mode().Perm()&0o111 == 0 {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "voice.livekit_binary is not executable")
		return false
	}
	if pathWithin(path, g.next.Server.DataDir) || pathWithin(path, g.next.Upload.StorageDir) ||
		pathWithin(path, g.next.Backup.Dir) || pathWithin(path, g.next.Plugins.Directory) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "voice.livekit_binary must not live under the data, uploads, backups or plugins directory")
		return false
	}
	if !binarySafeFromServerUser(path, info) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "voice.livekit_binary must not be owned or writable by the server's own user")
		return false
	}
	return true
}

// containerOutsideDataDir refuses a written path outside data_dir when the
// server runs in a container: only data_dir is a volume, so the path would
// vanish when the container is recreated.
func containerOutsideDataDir(g guardContext, path, key string, w http.ResponseWriter) bool {
	if updater.RunningInContainer() && !pathWithin(path, g.next.Server.DataDir) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST",
			key+": in a container only server.data_dir is a persistent volume; a path outside it would vanish when the container is recreated")
		return true
	}
	return false
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func dirEmpty(path string) bool {
	entries, err := os.ReadDir(path)
	return err == nil && len(entries) == 0
}

// dirWritable probes the directory by creating and removing a temp file, so it
// reports what the server's own user can actually do.
func dirWritable(dir string) bool {
	f, err := os.CreateTemp(dir, ".owncord-probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

func samePath(a, b string) bool {
	return filepath.Clean(a) == filepath.Clean(b)
}

// pathWithin reports whether child is parent or lives under it.
func pathWithin(child, parent string) bool {
	if child == "" || parent == "" {
		return false
	}
	c, err1 := filepath.Abs(child)
	p, err2 := filepath.Abs(parent)
	if err1 != nil || err2 != nil {
		return false
	}
	rel, err := filepath.Rel(p, c)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}
