package ws

import (
	"net"
	"sync/atomic"

	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
)

type hubSeams struct {
	registry *HandlerRegistry
	// focusDeps is the presence handlers' dependency set; the deferred-focus drain reuses its
	// limiter and channel service so it meters and authorises like handleChannelFocusV2. ChannelSvc
	// is nil in bare test hubs.
	focusDeps PresenceDeps
	// messageSvc gates plugin broadcasts through the same posting policy as a real send; nil only
	// in bare test hubs, where the gate fails closed.
	messageSvc     *service.MessageService
	pluginRegistry *plugin.Registry
	privacy        ChannelPrivacy
	// authn is the auth family's service: bearer-token resolution, the sweep's session verdicts and
	// the connect audit row. Required.
	authn SocketAuthenticator
	// trustedProxyNets is server.trusted_proxies parsed once, so a reverse-proxy deployment records
	// the client, not the proxy hop. Empty means RemoteAddr is used.
	trustedProxyNets []*net.IPNet
}

// hubEventTier groups event persistence, cold-replay and plugin fan-out state. It holds atomics:
// never copy it.
type hubEventTier struct {
	// Event persistence; nil means ring buffer only. Atomic because internal/app wires these after
	// Run has started.
	eventPersister atomic.Pointer[EventPersister]
	eventStore     atomic.Pointer[EventStore] // read path for cold-tier replay

	pluginSink atomic.Pointer[plugin.EventSink] // hub→plugin event fan-out; nil = no plugins

	coldReplayLimit int
}
