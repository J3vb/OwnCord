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

// validateAvatarURL checks that avatar is empty or an https:// URL no longer
// than maxAvatarURLLen, and that a URL on the server's own host is an attachment
// route.
// A same-host URL is otherwise an amplification primitive: the client attaches
// the session bearer token to requests whose host equals the server, so every
// viewer rendering the user would fetch an arbitrary path on this origin with
// their credentials. The only legitimate same-host avatar is the attachment
// route this server writes (service.AvatarFileURL); other hosts are fetched
// anonymously through the client's external-content broker.
// selfHosts come from configuration (configuredSelfHosts), NOT the
// client-supplied Host header: trusting it alone let an attacker name an
// arbitrary Host and slip a same-origin path past the comparison. The request's
// Host is still one extra candidate, which only widens what is refused, and it
// covers a server with no tls.domain reached by DNS name or behind a reverse
// proxy.
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

// configuredSelfHosts derives the host[:port] names this server is reachable
// on, for the same-host avatar guard: the operator-configured public host
// (tls.domain, which names this server when TLS terminates here) plus every
// bound listen address on this host, each with the configured listen port (an
// explicit default port compares equal to none, see isSelfHost).
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

// isSelfHost reports whether parsed names this server: its host:port matches a
// self host or the request's Host header. Default ports are stripped from both
// sides.
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

// isAvatarAttachmentPath reports whether path is this server's avatar file
// route: /api/v1/files/<uuid>. The uuid check mirrors what the upload handler
// actually stores, so a path that merely looks similar cannot be used to reach
// another handler.
func isAvatarAttachmentPath(path string) bool {
	id, ok := strings.CutPrefix(path, "/api/v1/files/")
	if !ok {
		return false
	}
	_, err := uuid.Parse(id)
	return err == nil
}
