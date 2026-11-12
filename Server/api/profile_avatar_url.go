package api

import (
	"fmt"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/netclass"
	"github.com/google/uuid"
)

// validateAvatarURL checks that avatar is empty or an https:// URL within maxAvatarURLLen, and that a URL on
// the server's own host is an attachment route. A same-host URL is otherwise an amplification primitive: the
// client attaches the session bearer token to same-host requests, so every viewer would fetch an arbitrary
// path on this origin with their credentials. Other hosts are fetched anonymously through the
// external-content broker. selfHosts come from configuration (configuredSelfHosts), NOT the client-supplied
// Host header, which alone let an attacker name an arbitrary Host; the request Host is an extra candidate
// that only widens what is refused.
func validateAvatarURL(avatar string, selfHosts []string, requestHost string) error {
	if avatar == "" {
		return nil
	}
	if len(avatar) > maxAvatarURLLen {
		return fmt.Errorf("avatar URL too long (max %d characters)", maxAvatarURLLen)
	}
	parsed, err := url.Parse(avatar)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return fmt.Errorf("avatar URL must use https://")
	}
	if isSelfHost(parsed, selfHosts, requestHost) && !isAvatarAttachmentPath(parsed.Path) {
		return fmt.Errorf("avatar URL on this server must be /api/v1/files/<id>")
	}
	return nil
}

// configuredSelfHosts derives the host[:port] names this server is reachable on: tls.domain plus every bound
// listen address, each with the listen port (an explicit default port compares equal to none, see
// isSelfHost).
func configuredSelfHosts(cfg *config.Config) []string {
	var names []string
	port := ""
	if cfg != nil {
		if d := strings.TrimSpace(cfg.TLS.Domain); d != "" {
			names = append(names, d)
		}
		if cfg.Server.Port > 0 {
			port = strconv.Itoa(cfg.Server.Port)
		}
	}
	for _, a := range netclass.LocalAddrs() {
		names = append(names, a.String())
	}
	hosts := make([]string, 0, len(names))
	for _, n := range names {
		if port == "" {
			if strings.Contains(n, ":") {
				n = "[" + n + "]"
			}
			hosts = append(hosts, n)
			continue
		}
		hosts = append(hosts, net.JoinHostPort(n, port))
	}
	return hosts
}

// isSelfHost reports whether parsed names this server (host:port matches a self host or the request Host).
func isSelfHost(parsed *url.URL, selfHosts []string, requestHost string) bool {
	parsedHost := stripDefaultPort(parsed.Scheme, parsed.Host)
	for _, candidate := range append(slices.Clip(selfHosts), requestHost) {
		if candidate == "" {
			continue
		}
		if strings.EqualFold(parsedHost, stripDefaultPort(parsed.Scheme, candidate)) {
			return true
		}
	}
	return false
}

// isAvatarAttachmentPath reports whether path is /api/v1/files/<uuid>; the uuid check mirrors what the
// upload handler stores, so a similar-looking path cannot reach another handler.
func isAvatarAttachmentPath(path string) bool {
	id, ok := strings.CutPrefix(path, "/api/v1/files/")
	if !ok {
		return false
	}
	_, err := uuid.Parse(id)
	return err == nil
}
