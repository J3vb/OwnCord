package ws

import (
	"net"
	"sync/atomic"

	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
)

// hubSeams groups the services and policy sources the hub calls out to.
type hubSeams struct {
	registry *HandlerRegistry
	// focusDeps is the presence handlers' dependency set; the deferred-focus drain
	// goroutine (focus_defer.go) reuses its limiter and channel service so it meters
	// and authorises like handleChannelFocusV2. ChannelSvc is nil in bare test hubs.
	focusDeps PresenceDeps
	// messageSvc gates plugin broadcasts through the same posting policy as a real
	// send (permissions, DM membership, blocks). Nil only in bare test hubs; the gate
	// then fails closed.
	messageSvc *service.MessageService
	// pluginRegistry is the slash-command dispatch; nil = no plugins; HubOptions field.
	pluginRegistry *plugin.Registry
	// privacy is the channel-level private flag source (nil: nothing private).
	privacy ChannelPrivacy
	// authn is the auth family's service (SocketAuthenticator): bearer-token
	// resolution, the sweep's session verdicts and the connect audit row. Required.
	authn SocketAuthenticator
	// trustedProxyNets is server.trusted_proxies parsed once: the handshake resolves
	// the client address for its log line and ws_connect audit row through it, so a
	// reverse-proxy deployment records the client, not the proxy hop. Empty means
	// RemoteAddr is used and a client-supplied header is ignored.
	trustedProxyNets []*net.IPNet
}

// hubEventTier groups the event persistence, cold-replay and plugin fan-out
// state. It holds atomics: never copy it.
type hubEventTier struct {
	// Event persistence; nil means ring buffer only. Atomic because internal/app wires
	// these one lifecycle stage after Run has started, and Run reads them on the
	// broadcast/replay paths.
	eventPersister atomic.Pointer[EventPersister]
	eventStore     atomic.Pointer[EventStore] // read path for cold-tier replay

	pluginSink atomic.Pointer[plugin.EventSink] // hub→plugin event fan-out; nil = no plugins

	// coldReplayLimit caps persisted-event replay per reconnect; 0 = maxColdReplay.
	coldReplayLimit int
}
