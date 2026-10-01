package api

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/netclass"
	"github.com/google/uuid"
)

// validateAvatarURL checks that avatar is either empty or a valid https:// URL
// no longer than maxAvatarURLLen characters, and that a URL on the server's own
// host is an attachment route.
//
// A same-host URL is otherwise an amplification primitive: the client attaches
// the session bearer token to a request whose host equals the server, so every
// viewer that renders the user would fetch an arbitrary path on this origin
// with their credentials. The only legitimate same-host avatar is the
// attachment route this server writes to users.avatar (service.AvatarFileURL),
// so anything else on this host is refused. Different hosts are unaffected —
// they are fetched anonymously through the client's external-content broker.
//
// selfHosts are the hosts this server answers on, derived from configuration
// (configuredSelfHosts), NOT from the request: the Host header is
// client-supplied, so trusting it alone let an attacker name an arbitrary Host
// and slip an arbitrary same-origin path past the comparison. The request's own
// Host is still one extra candidate: that only widens what is refused, so a
// spoofed Host can never cause an acceptance, and it covers a server with no
// tls.domain that is reached by DNS name or behind a reverse proxy.
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
	for _, candidate := range append(selfHosts[:len(selfHosts):len(selfHosts)], requestHost) {
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
