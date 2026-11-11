package ws

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/clientip"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/livekitproc"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws/hubsettings"
	"github.com/J3vb/OwnCord/Server/ws/voicestate"
)

// HubOptions carries everything a Hub needs before Run starts. What is mutable after Run stays a
// setter: the event persister, event store and plugin event sink are atomic hot-swaps wired after
// the loop starts, and SetPendingVoiceModFlags is per-user runtime state.
type HubOptions struct {
	// DB and Limiter are required: every dispatch path reads the database and handler deps capture
	// the limiter at registration.
	DB      *db.DB
	Limiter *auth.RateLimiter

	// Services is the domain layer V2 handlers delegate to; nil is the degraded test fixture with
	// direct-DB fallbacks.
	Services *service.Services

	// Settings is required: the settings cache (server name, MOTD on every auth_ok) reads through
	// it.
	Settings SettingsReader

	// Readers is required: snapshot, visibility, member-payload and dispatch reads go through these
	// seams (readers.go).
	Readers HubReaders

	// Voice is required: every voice_states read and write goes through it.
	Voice VoiceStore

	// Presence is required: the connection lifecycle's two status writes.
	Presence PresenceStamper

	// Auth is required: the handshake resolves its bearer token through it and the sweep checks
	// each live session.
	Auth SocketAuthenticator

	// ChannelPrivacy backs the channel-level private flag; optional, nil means nothing is private.
	ChannelPrivacy ChannelPrivacy

	// LiveKit is the voice token signer; nil means voice is not configured and every join is
	// refused. LiveKitProcess is the supervised SFU and requires LiveKit; voice_join fails closed
	// while a non-nil process is not running.
	LiveKit        *LiveKitClient
	LiveKitProcess *livekitproc.Process

	// PluginRegistry enables plugin slash commands; nil disables. The plugin event sink consumes
	// the built hub's broadcaster, so it stays the two-phase SetPluginEventSink.
	PluginRegistry *plugin.Registry

	// Replay budget (event_persistence.replay_ring_size / replay_cold_limit). Zero keeps defaults;
	// negative is refused.
	ReplayRingSize  int
	ReplayColdLimit int

	// VoiceQuality is the operator-configured voice.quality, voice_join's only source of a
	// channel's quality. Startup-only; empty or unknown falls back to "medium".
	VoiceQuality string

	UploadPolicy UploadPolicy

	// UploadFileTypes supplies upload_policy's two extension lists; nil leaves them out.
	UploadFileTypes UploadFileTypes

	// TrustedProxies is server.trusted_proxies: the proxy hops whose X-Forwarded-For/X-Real-IP may
	// be trusted for the handshake log and ws_connect audit row. Nil/empty means RemoteAddr is used
	// and client-supplied headers are ignored.
	TrustedProxies []string
}

// UploadPolicy is what a client needs to refuse a doomed upload before sending it.
type UploadPolicy = hubsettings.UploadPolicy

// UploadFileTypes reads the upload file-type policy in force; service.UploadService satisfies it.
type UploadFileTypes = hubsettings.FileTypes

func validateHubOptions(opts HubOptions) error {
	if opts.DB == nil {
		return errors.New("ws: HubOptions.DB is required (every dispatch path reads it)")
	}
	if opts.Limiter == nil {
		return errors.New("ws: HubOptions.Limiter is required (handler deps capture it at registration)")
	}
	if opts.Settings == nil {
		return errors.New("ws: HubOptions.Settings is required (the settings cache reads through it)")
	}
	if !opts.Readers.complete() {
		return errors.New("ws: HubOptions.Readers is required in full (the hub reads through its seams)")
	}
	if opts.Voice == nil {
		return errors.New("ws: HubOptions.Voice is required (every voice path reads and writes through it)")
	}
	if opts.Presence == nil {
		return errors.New("ws: HubOptions.Presence is required (the connect and disconnect status stamps go through it)")
	}
	if opts.Auth == nil {
		return errors.New("ws: HubOptions.Auth is required (the handshake and the session sweep resolve through it)")
	}
	if opts.LiveKitProcess != nil && opts.LiveKit == nil {
		return errors.New("ws: HubOptions.LiveKitProcess without LiveKit — a supervised SFU no client can sign tokens for")
	}
	if opts.ReplayRingSize < 0 || opts.ReplayColdLimit < 0 {
		return fmt.Errorf("ws: negative replay budget (ring %d, cold %d)", opts.ReplayRingSize, opts.ReplayColdLimit)
	}
	return nil
}

// NewHub creates a Hub ready for Run, validating required collaborators and initializing the
// settings cache from the database.
func NewHub(opts HubOptions) (*Hub, error) {
	if err := validateHubOptions(opts); err != nil {
		return nil, err
	}

	database, limiter, svc := opts.DB, opts.Limiter, opts.Services
	ringSize := cmp.Or(max(opts.ReplayRingSize, 0), 1000) // unset or negative: 1000

	reg := NewHandlerRegistry()

	defaultVoiceQuality := "medium"
	if validVoiceQuality(opts.VoiceQuality) {
		defaultVoiceQuality = opts.VoiceQuality
	}

	h := &Hub{
		clients: make(map[int64][]*Client),
		db:      database,
		limiter: limiter,
		readers: opts.Readers,
		voice:   opts.Voice,
		voiceHub: hubVoice{
			defaultQuality: defaultVoiceQuality, mod: voicestate.NewUserLocks[lockRankVoiceMod](),
			keyHolders: make(map[int64]int64), lkProcess: opts.LiveKitProcess,
		},
		presence:     opts.Presence,
		broadcast:    make(chan broadcastMsg, 1024),
		clientEvents: make(chan clientEvent, 64),
		readyGate:    make(chan struct{}, 2*runtime.GOMAXPROCS(0)),
		stop:         make(chan struct{}),
		pubsub:       NewPubSub(),
		replayBuf:    NewEventRingBuffer(ringSize),
		permChecker:  permissions.NewChecker(database),
		settings: hubSettings{
			cache: hubsettings.New(opts.Settings, opts.UploadFileTypes, opts.UploadPolicy),
		},
		lifecycle: hubLifecycle{
			runDone: make(chan struct{}),
			fatalFn: func() { os.Exit(1) },
		},
		livekit: opts.LiveKit,
		seams: hubSeams{
			registry:         reg,
			pluginRegistry:   opts.PluginRegistry,
			privacy:          opts.ChannelPrivacy,
			authn:            opts.Auth,
			trustedProxyNets: clientip.ParseCIDRList(opts.TrustedProxies),
		},
	}
	if opts.ReplayColdLimit > 0 {
		h.events.coldReplayLimit = opts.ReplayColdLimit
	}
	h.initLife() // the hub's own lifecycle, ended by closeStop
	registerPingHandler(reg, PingDeps{Limiter: h.limiter})

	chatDeps := ChatDeps{
		Limiter:    h.limiter,
		LiveStatus: h.LiveStatus,
		LiveMobile: h.LiveMobile,
	}
	presenceDeps := PresenceDeps{Limiter: h.limiter, GameActivityEnabled: h.settings.gameActivity.on.Load}
	reactionDeps := ReactionDeps{}
	callDeps := CallDeps{Limiter: h.limiter}
	if svc != nil {
		chatDeps.MessageSvc = svc.Messages
		presenceDeps.ChannelSvc = svc.Channels
		presenceDeps.MessageSvc = svc.Messages
		reactionDeps.MessageSvc = svc.Messages
		callDeps.DMSvc = svc.DMs
		h.seams.messageSvc = svc.Messages
		h.perms = svc.Permissions
		// So @here's offline narrowing can tell a disconnected idle/dnd reader (users.status keeps
		// their last choice) from a connected one, the live-connection rule presentableMembers
		// applies.
		svc.Messages.SetLiveStatusLookup(h.LiveStatus)
		// So every DM payload DMService builds applies the same live-connection rule.
		svc.DMs.SetLiveStatusLookup(h.LiveStatus)
		svc.DMs.SetLiveMobileLookup(h.LiveMobile)
		// A mention raising a badge in a channel the reader is not viewing never reaches them via
		// the channel topic, so the mention worker pushes a per-user mention_count frame. Installed
		// before the composition root starts the worker.
		svc.Messages.SetMentionNotifier(h)
		// read_state is sent by MoveReadPointer under the same lock as the mention frames.
		svc.Messages.SetReadStateNotifier(h)
		svc.CallLog.SetSink(h) // before the worker starts
	}

	registerChatHandlers(reg, chatDeps)
	h.wireThreads(reg, svc)
	h.seams.focusDeps = presenceDeps
	registerPresenceHandlers(reg, presenceDeps)
	registerReactionHandlers(reg, reactionDeps)
	registerCallHandlers(reg, callDeps)
	// Plugin slash commands. The registry stays a closure (it predates HubOptions) for the nil-
	// interface reason below.
	reg.RegisterV2(MsgTypeChatCommand, handleChatCommandV2, PluginDeps{
		// A nil registry must yield a nil interface, not a typed-nil *plugin.Registry: the
		// handler's "no plugins loaded" check is an interface comparison.
		Registry: func() CommandDispatcher {
			if h.seams.pluginRegistry == nil {
				return nil
			}
			return h.seams.pluginRegistry
		},
		MessageSvc: h.seams.messageSvc,
		Limiter:    h.limiter,
	})
	registerVoiceControlsV2(reg, h.voiceDeps())

	h.settings.cache.Refresh(context.Background())
	h.initGameActivityPolicy()
	h.initVideoBitrateCap()
	return h, nil
}

func (h *Hub) voiceDeps() VoiceDeps {
	return VoiceDeps{
		Voice:       h.voice,
		Reader:      h.readers.Dispatch,
		Limiter:     h.limiter,
		Permissions: h.permChecker,
		PermSvc:     h.perms,
		LiveKit:     h.livekit,
		TokenGen:    h, // Hub delegates to h.livekit at call time
		KeyHolder:   h,
		Mod:         h,
		Settings:    h.settings.cache.Reader(),
	}
}

// maxColdReplayLimit returns the effective persisted-replay cap. The dispatch loop reads replayBuf
// unlocked, so the ring is sized once at construction.
func (h *Hub) maxColdReplayLimit() int {
	if h.events.coldReplayLimit > 0 {
		return h.events.coldReplayLimit
	}
	return maxColdReplay
}
