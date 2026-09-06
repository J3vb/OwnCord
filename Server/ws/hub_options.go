package ws

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
)

// HubOptions carries everything a Hub needs before Run starts (S-11 / B3-4).
// The four pre-Run setters this struct replaced (SetLiveKit,
// SetLiveKitProcess, SetPluginRegistry, ConfigureReplay) were all guarded by
// rejectIfRunning — construction-phase wiring pretending to be mutable state.
// What genuinely IS mutable after Run stays a setter: the event persister,
// event store and plugin event sink are atomic hot-swaps that the app wires
// after the dispatch loop starts (internal/app/persistence.go), and
// SetPendingVoiceModFlags is per-user runtime state.
type HubOptions struct {
	// DB and Limiter are required: every dispatch path reads the database,
	// and the handler deps capture the limiter at registration. NewHub
	// refuses to build a Hub without them.
	DB      *db.DB
	Limiter *auth.RateLimiter

	// Services is the domain layer V2 handlers delegate to. Production
	// always passes it; nil is the degraded fixture many ws tests build,
	// where handlers keep their direct-DB fallback paths.
	Services *service.Services

	// Settings is required: the hub's settings cache (server name and MOTD
	// on every auth_ok) reads through it instead of the raw handle — the
	// B3-8 settings family owns those reads. Production passes
	// Services.Settings; test helpers default it over the test database.
	Settings SettingsReader

	// Readers is required: the hub's snapshot, visibility, member-payload
	// and dispatch reads go through these seams (readers.go) instead of the
	// raw handle. Production wires DBReaders; test helpers default it over
	// the test database.
	Readers HubReaders

	// Voice is required: every voice_states read and write the hub makes —
	// join, moderation, self controls, the stale sweep and channel teardown
	// — goes through it. Production passes Services.Voice; test helpers
	// default it to a service over the test database.
	Voice VoiceStore

	// Presence is required: the connection lifecycle's two status writes.
	// Production passes Services.Users; test helpers default it to a service
	// over the test database.
	Presence PresenceStamper

	// Auth is required: the handshake resolves its bearer token through it,
	// and the periodic sweep asks it whether each live session is still good.
	// Production passes Services.Sessions; test helpers default it over the
	// test database.
	Auth SocketAuthenticator

	// LiveKit is the voice token signer; nil means voice is not configured
	// and every voice join is refused. LiveKitProcess is the supervised
	// companion SFU — it requires LiveKit, because a process no client can
	// sign tokens for is unusable, and the voice_join guard reads a non-nil
	// process's IsRunning to fail closed while it is down.
	LiveKit        *LiveKitClient
	LiveKitProcess *LiveKitProcess

	// PluginRegistry enables plugin slash-command dispatch; nil disables it.
	// The plugin event sink is NOT here: it consumes the built hub's
	// broadcaster, so it stays the two-phase SetPluginEventSink.
	PluginRegistry *plugin.Registry

	// Replay budget (event_persistence.replay_ring_size / replay_cold_limit).
	// Zero keeps the compiled-in defaults; negative is refused rather than
	// silently ignored.
	ReplayRingSize  int
	ReplayColdLimit int
}

// NewHub creates a Hub ready to be started with Run, validating that the
// required collaborators are present — before B3-4, construction always
// succeeded and a missing collaborator surfaced as a later panic or a
// silently refused setter call. It also initializes the settings cache from
// the database. If opts.Services is non-nil, V2 handlers receive service
// references for business logic delegation.
// validateHubOptions is NewHub's required-collaborator gate, split out so
// the constructor body stays within the function-length lint bound.
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

func NewHub(opts HubOptions) (*Hub, error) {
	if err := validateHubOptions(opts); err != nil {
		return nil, err
	}

	database, limiter, svc := opts.DB, opts.Limiter, opts.Services
	settingsReader := opts.Settings

	ringSize := 1000
	if opts.ReplayRingSize > 0 {
		ringSize = opts.ReplayRingSize
	}

	reg := NewHandlerRegistry()

	h := &Hub{
		clients:         make(map[int64]*Client),
		db:              database,
		limiter:         limiter,
		settings:        settingsReader,
		readers:         opts.Readers,
		voice:           opts.Voice,
		presence:        opts.Presence,
		authn:           opts.Auth,
		broadcast:       make(chan broadcastMsg, 1024),
		clientEvents:    make(chan clientEvent, 64),
		stop:            make(chan struct{}),
		pubsub:          NewPubSub(),
		topicLimiter:    NewTopicRateLimiter(topicRateLimitPerSecond, time.Second),
		replayBuf:       NewEventRingBuffer(ringSize),
		registry:        reg,
		permChecker:     permissions.NewChecker(database),
		settingsName:    "OwnCord Server",
		settingsMotd:    "Welcome!",
		voiceKeyHolders: make(map[int64]int64),
		fatalFn:         func() { os.Exit(1) },
		livekit:         opts.LiveKit,
		lkProcess:       opts.LiveKitProcess,
		pluginRegistry:  opts.PluginRegistry,
	}
	if opts.ReplayColdLimit > 0 {
		h.coldReplayLimit = opts.ReplayColdLimit
	}

	// V2 handler registrations (need Hub fields for deps).
	registerPingHandler(reg, PingDeps{Limiter: h.limiter})

	chatDeps := ChatDeps{
		Limiter: h.limiter,
	}
	presenceDeps := PresenceDeps{
		Limiter: h.limiter,
	}
	reactionDeps := ReactionDeps{}
	callDeps := CallDeps{Limiter: h.limiter}
	if svc != nil {
		chatDeps.MessageSvc = svc.Messages
		presenceDeps.ChannelSvc = svc.Channels
		presenceDeps.MessageSvc = svc.Messages
		reactionDeps.MessageSvc = svc.Messages
		callDeps.DMSvc = svc.DMs
		h.messageSvc = svc.Messages
		h.perms = svc.Permissions
		// So @here's offline narrowing can tell a disconnected idle/dnd reader
		// (users.status keeps their last *chosen* value across a disconnect)
		// from one who is actually still connected — the same live-connection
		// rule presentableMembers applies to the members array.
		svc.Messages.SetOnlineChecker(h.IsUserConnected)
		// So every DM payload DMService builds (GET/POST /dms, POST
		// /dms/group, PATCH /dms/{id}, and every broadcastDMOpen refresh)
		// applies the same live-connection rule instead of only the ready
		// payload's presentableDMChannels doing so (OC-0304).
		svc.DMs.SetOnlineChecker(h.IsUserConnected)
	}

	registerChatHandlers(reg, chatDeps)
	registerPresenceHandlers(reg, presenceDeps)
	registerReactionHandlers(reg, reactionDeps)
	registerCallHandlers(reg, callDeps)
	// Phase C Step 9 — plugin slash commands. The registry closure predates
	// B3-4 (the registry used to arrive via a post-construction setter); it
	// stays a closure for the nil-interface reason below. MessageSvc gates
	// broadcasts.
	reg.RegisterV2(MsgTypeChatCommand, handleChatCommandV2, PluginDeps{
		// A nil registry must yield a nil interface, not a typed-nil
		// *plugin.Registry — the handler's "no plugins loaded" check is an
		// interface comparison.
		Registry: func() CommandDispatcher {
			if h.pluginRegistry == nil {
				return nil
			}
			return h.pluginRegistry
		},
		MessageSvc: h.messageSvc,
		Limiter:    h.limiter,
	})
	registerVoiceControlsV2(reg, VoiceDeps{
		Voice:       h.voice,
		Reader:      h.readers.Dispatch,
		Limiter:     h.limiter,
		Permissions: h.permChecker,
		PermSvc:     h.perms,
		LiveKit:     h.livekit,
		TokenGen:    h, // Hub delegates to h.livekit at call time
		KeyHolder:   h,
		Mod:         h,
	})

	h.refreshSettingsLocked(context.Background())
	return h, nil
}
