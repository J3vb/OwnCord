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
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// HubOptions carries everything a Hub needs before Run starts. What is mutable
// after Run stays a setter: the event persister, event store and plugin event sink
// are atomic hot-swaps wired after the dispatch loop starts
// (internal/app/persistence.go), and SetPendingVoiceModFlags is per-user runtime state.
type HubOptions struct {
	// DB and Limiter are required: every dispatch path reads the database and the
	// handler deps capture the limiter at registration. NewHub refuses to build without them.
	DB      *db.DB
	Limiter *auth.RateLimiter

	// Services is the domain layer V2 handlers delegate to. Production always passes
	// it; nil is the degraded test fixture whose handlers keep their direct-DB fallbacks.
	Services *service.Services

	// Settings is required: the settings cache (server name and MOTD on every auth_ok)
	// reads through it. Production passes Services.Settings; test helpers default it
	// over the test database.
	Settings SettingsReader

	// Readers is required: snapshot, visibility, member-payload and dispatch reads go
	// through these seams (readers.go). Production wires DBReaders; test helpers
	// default it.
	Readers HubReaders

	// Voice is required: every voice_states read and write the hub makes goes through
	// it. Production passes Services.Voice; test helpers default it.
	Voice VoiceStore

	// Presence is required: the connection lifecycle's two status writes. Production
	// passes Services.Users.
	Presence PresenceStamper

	// Auth is required: the handshake resolves its bearer token through it and the
	// sweep asks whether each live session is still good. Production passes
	// Services.Sessions.
	Auth SocketAuthenticator

	// ChannelPrivacy backs the channel-level private flag on channel frames. Optional:
	// nil means nothing is private. Production passes Services.ChannelPrivacy.
	ChannelPrivacy ChannelPrivacy

	// LiveKit is the voice token signer; nil means voice is not configured and every
	// voice join is refused. LiveKitProcess is the supervised companion SFU; it
	// requires LiveKit (a process no client can sign tokens for is unusable), and the
	// voice_join guard reads a non-nil process's IsRunning to fail closed while down.
	LiveKit        *LiveKitClient
	LiveKitProcess *LiveKitProcess

	// PluginRegistry enables plugin slash-command dispatch; nil disables it. The
	// plugin event sink consumes the built hub's broadcaster, so it stays the
	// two-phase SetPluginEventSink.
	PluginRegistry *plugin.Registry

	// Replay budget (event_persistence.replay_ring_size / replay_cold_limit). Zero
	// keeps the defaults; negative is refused.
	ReplayRingSize  int
	ReplayColdLimit int

	// VoiceQuality is the operator-configured voice.quality, voice_join's only source of
	// a channel's quality. Startup-only (the setup wizard treats it as
	// restart-required). Empty or not one of voiceQualities' keys falls back to "medium".
	VoiceQuality string

	// UploadPolicy is advertised on every auth_ok as upload_policy. Startup-only.
	UploadPolicy UploadPolicy

	// UploadFileTypes supplies upload_policy's two extension lists, read with the
	// server_name/motd cache. Nil leaves them out.
	UploadFileTypes UploadFileTypes

	// TrustedProxies is server.trusted_proxies: the proxy hop(s) whose
	// X-Forwarded-For/X-Real-IP may be trusted when resolving the client address for the
	// handshake log and ws_connect audit row. Parsed once; nil/empty means RemoteAddr
	// is used and a client-supplied header is ignored.
	TrustedProxies []string
}

// UploadPolicy is what a client needs to refuse a doomed upload before sending it.
// The upload route stays authoritative; this is only a pre-check.
type UploadPolicy struct {
	// MaxUploadBytes is upload.max_size_mb in bytes; 0 means uploads are disabled.
	MaxUploadBytes int64 `json:"max_upload_bytes"`
	// BlockedExtensions and AllowedExtensions are the file-type policy in force
	// (storage.FileTypePolicy): a blocked final extension is refused; a non-empty
	// allowed list is allow-only mode.
	BlockedExtensions []string `json:"blocked_extensions,omitempty"`
	AllowedExtensions []string `json:"allowed_extensions,omitempty"`
	// Thumbnails reports that GET /api/v1/files/{id}/thumb exists, so a client asks for an
	// inline image's thumbnail instead of the original.
	Thumbnails bool `json:"thumbnails,omitempty"`
}

// UploadFileTypes reads the upload file-type policy in force; service.UploadService satisfies it.
type UploadFileTypes interface {
	FileTypePolicy(ctx context.Context) (storage.FileTypePolicy, error)
}

// validateHubOptions is NewHub's required-collaborator gate, split out to keep the
// constructor within the function-length lint bound.
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

// NewHub creates a Hub ready to be started with Run, validating that the
// required collaborators are present, and initializes the settings cache from
// the database. If opts.Services is non-nil, V2 handlers receive service
// references for business logic delegation.
func NewHub(opts HubOptions) (*Hub, error) {
	if err := validateHubOptions(opts); err != nil {
		return nil, err
	}

	database, limiter, svc := opts.DB, opts.Limiter, opts.Services
	ringSize := cmp.Or(max(opts.ReplayRingSize, 0), 1000) // unset or negative: 1000

	reg := NewHandlerRegistry()

	// Normalize once rather than propagating an unset or invalid value into every voice_config.
	defaultVoiceQuality := "medium"
	if validVoiceQuality(opts.VoiceQuality) {
		defaultVoiceQuality = opts.VoiceQuality
	}

	h := &Hub{
		clients:             make(map[int64][]*Client),
		db:                  database,
		limiter:             limiter,
		settings:            opts.Settings,
		readers:             opts.Readers,
		voice:               opts.Voice,
		defaultVoiceQuality: defaultVoiceQuality,
		settingsUpload:      opts.UploadPolicy,
		uploadFileTypes:     opts.UploadFileTypes,
		voiceMod:            newUserLocks[lockRankVoiceMod](),
		presence:            opts.Presence,
		authn:               opts.Auth,
		privacy:             opts.ChannelPrivacy,
		trustedProxyNets:    clientip.ParseCIDRList(opts.TrustedProxies),
		broadcast:           make(chan broadcastMsg, 1024),
		clientEvents:        make(chan clientEvent, 64),
		readyGate:           make(chan struct{}, 2*runtime.GOMAXPROCS(0)),
		stop:                make(chan struct{}),
		runDone:             make(chan struct{}),
		pubsub:              NewPubSub(),
		replayBuf:           NewEventRingBuffer(ringSize),
		registry:            reg,
		permChecker:         permissions.NewChecker(database),
		settingsName:        "OwnCord Server",
		settingsMotd:        "Welcome!",
		voiceKeyHolders:     make(map[int64]int64),
		fatalFn:             func() { os.Exit(1) },
		livekit:             opts.LiveKit,
		lkProcess:           opts.LiveKitProcess,
		pluginRegistry:      opts.PluginRegistry,
	}
	if opts.ReplayColdLimit > 0 {
		h.coldReplayLimit = opts.ReplayColdLimit
	}
	h.initLife() // the hub's own lifecycle, ended by closeStop
	registerPingHandler(reg, PingDeps{Limiter: h.limiter})

	chatDeps := ChatDeps{
		Limiter:    h.limiter,
		LiveStatus: h.LiveStatus,
	}
	presenceDeps := PresenceDeps{Limiter: h.limiter, GameActivityEnabled: h.gameActivity.on.Load}
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
		// So @here's offline narrowing can tell a disconnected idle/dnd reader (users.status
		// keeps their last chosen value) from one still connected, the live-connection rule
		// presentableMembers applies.
		svc.Messages.SetLiveStatusLookup(h.LiveStatus)
		// So every DM payload DMService builds applies the same live-connection rule, not
		// only the ready payload's presentableDMChannels.
		svc.DMs.SetLiveStatusLookup(h.LiveStatus)
		// A mention raising a badge in a channel the reader is not viewing never reaches
		// them via the channel topic, so the mention worker pushes a per-user
		// mention_count frame. Installed before the composition root starts the worker so
		// StartMentionWorker captures it.
		svc.Messages.SetMentionNotifier(h)
		// The read_state frame MoveReadPointer sends under the same lock the mention frames use.
		svc.Messages.SetReadStateNotifier(h)
		svc.CallLog.SetSink(h) // before the worker starts
	}

	registerChatHandlers(reg, chatDeps)
	h.wireThreads(reg, svc)
	h.focusDeps = presenceDeps
	registerPresenceHandlers(reg, presenceDeps)
	registerReactionHandlers(reg, reactionDeps)
	registerCallHandlers(reg, callDeps)
	// Plugin slash commands. The registry stays a closure (it predates HubOptions) for
	// the nil-interface reason below. MessageSvc gates broadcasts.
	reg.RegisterV2(MsgTypeChatCommand, handleChatCommandV2, PluginDeps{
		// A nil registry must yield a nil interface, not a typed-nil *plugin.Registry: the
		// handler's "no plugins loaded" check is an interface comparison.
		Registry: func() CommandDispatcher {
			if h.pluginRegistry == nil {
				return nil
			}
			return h.pluginRegistry
		},
		MessageSvc: h.messageSvc,
		Limiter:    h.limiter,
	})
	registerVoiceControlsV2(reg, h.voiceDeps())

	h.refreshSettingsLocked(context.Background())
	h.initGameActivityPolicy()
	return h, nil
}

// voiceDeps is the dependency set the voice command handlers are registered with.
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
		Settings:    h.settings,
	}
}

// maxColdReplayLimit returns the effective persisted-replay cap. The budget arrives
// via HubOptions; the dispatch loop reads replayBuf unlocked, so the ring is sized
// once, at construction.
func (h *Hub) maxColdReplayLimit() int {
	if h.coldReplayLimit > 0 {
		return h.coldReplayLimit
	}
	return maxColdReplay
}
