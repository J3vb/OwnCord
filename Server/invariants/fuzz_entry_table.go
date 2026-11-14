package invariants

// The fuzz inventory: every server function where outside data is turned
// into structure. The fuzz-entry-points rule finds decoding calls (JSON, XML,
// images, archives, gzip, HTML, multipart) and asks each enclosing function
// to sit in exactly one of the three tables below. Hand-written parsers the
// rule cannot see by their calls are listed with Manual set.
//
// Keys are "<package dir>.<function>", the function spelled "Name" or
// "(*T).Name", or the name of a package-level variable whose closures decode.
// Keying by function rather than file means a decoder moved to another file
// in the same package keeps its row.
//
// The rule's row in docs/code-style.md summarises it; the nightly fuzz job
// (scripts/ci/fuzz-ci.mjs) runs every target named here.

// FuzzEntry is a function where outside data enters, with the fuzz targets
// that drive it. Targets are "<package dir>.FuzzName".
type FuzzEntry struct {
	Source  string // where the bytes come from
	Targets []string
	// Manual marks a hand-written parser or validator the rule cannot see by
	// its calls, listed so it keeps its target.
	Manual bool
}

// FuzzGap is an outside-input function with no fuzz target yet.
type FuzzGap struct {
	Source string
	Manual bool
}

// FuzzEntryPoints are the covered entry points.
var FuzzEntryPoints = map[string]FuzzEntry{
	"ws.(*Hub).handleMessageDecode": {Source: "every WebSocket frame after auth", Targets: []string{"ws.FuzzHandleMessageDecode"}},
	"ws.commandConstructors":        {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseCallChannelID":         {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseChatSend":              {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseChatForward":           {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parsePollCreate":            {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parsePollVote":              {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parsePollEnd":               {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseThreadCreate":          {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseThreadUpdate":          {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseThreadDelete":          {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseThreadFocus":           {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseThreadFollow":          {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseForumPostCreate":       {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseChannelFocus":          {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseMarkRead":              {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseMarkUnread":            {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parsePresenceUpdate":        {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseActivityUpdate":        {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseListeningUpdate":       {Source: "WebSocket command payloads", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.announceIdentityKey":        {Source: "voice E2EE announce payload", Targets: []string{"ws.FuzzCommandPayloads"}},
	"ws.parseParticipantIdentity":   {Source: "LiveKit webhook body", Targets: []string{"ws.FuzzParseParticipantIdentity"}, Manual: true},
	"ws.parseRoomChannelID":         {Source: "LiveKit webhook body", Targets: []string{"ws.FuzzParseRoomChannelID"}, Manual: true},

	"api.imageDimensions":        {Source: "emoji and sticker uploads", Targets: []string{"api.FuzzImageDimensions"}},
	"api.webpDimensions":         {Source: "emoji and sticker uploads", Targets: []string{"api.FuzzImageDimensions"}, Manual: true},
	"api.makeThumbnail":          {Source: "uploaded images", Targets: []string{"api.FuzzMakeThumbnail"}},
	"api.thumbOrientation":       {Source: "uploaded images", Targets: []string{"api.FuzzMakeThumbnail"}},
	"imgthumb.Fit":               {Source: "images fetched for link previews", Targets: []string{"imgthumb.FuzzFit"}},
	"imgthumb.Orientation":       {Source: "uploaded images", Targets: []string{"api.FuzzMakeThumbnail"}},
	"imgthumb.Make":              {Source: "uploaded images", Targets: []string{"api.FuzzMakeThumbnail"}},
	"api.validateHEIC":           {Source: "uploaded HEIC images", Targets: []string{"api.FuzzValidateHEIC"}, Manual: true},
	"api.validateAvatarURL":      {Source: "profile update body", Targets: []string{"api.FuzzValidateAvatarURL"}, Manual: true},
	"api.validateDisplayName":    {Source: "profile update body", Targets: []string{"api.FuzzValidateDisplayName"}, Manual: true},
	"api.sanitizeUploadFilename": {Source: "upload filename", Targets: []string{"api.FuzzSanitizeUploadFilename"}, Manual: true},

	"auth.ValidateUsername":         {Source: "register and profile bodies", Targets: []string{"auth.FuzzValidateUsername"}, Manual: true},
	"auth.ValidateNewUsername":      {Source: "register body", Targets: []string{"auth.FuzzValidateNewUsername"}, Manual: true},
	"auth.ValidateVisibleText":      {Source: "names and statuses users type", Targets: []string{"auth.FuzzValidateVisibleText"}, Manual: true},
	"auth.ValidatePasswordStrength": {Source: "register and password change bodies", Targets: []string{"auth.FuzzValidatePasswordStrength"}, Manual: true},

	"service.ParseSearch":        {Source: "search query", Targets: []string{"service.FuzzParseSearch"}, Manual: true},
	"service.sanitizeContent":    {Source: "message content", Targets: []string{"service.FuzzSanitizeContent", "service.FuzzSanitize_KeepsIDTokens"}, Manual: true},
	"service.parseMentionTokens": {Source: "message content", Targets: []string{"service.FuzzParseMentionTokens"}, Manual: true},
	"service.ValidateShortcode":  {Source: "emoji create body", Targets: []string{"service.FuzzValidateShortcode"}, Manual: true},

	"db.sanitizeFTSQuery":         {Source: "search query", Targets: []string{"db.FuzzSanitizeFTSQuery"}, Manual: true},
	"plugin.validateRelativePath": {Source: "plugin manifest paths", Targets: []string{"plugin.FuzzValidateRelativePath"}, Manual: true},
	"storage.sanitizeFilename":    {Source: "upload filename", Targets: []string{"storage.FuzzSanitizeFilename"}, Manual: true},
	"storage.ValidateFileType":    {Source: "upload bytes", Targets: []string{"storage.FuzzValidateFileType"}, Manual: true},

	"externalcontent.parseOGTags":   {Source: "fetched web pages (link previews)", Targets: []string{"externalcontent.FuzzParseOGTags"}},
	"externalcontent.parseOEmbed":   {Source: "fetched oEmbed responses", Targets: []string{"externalcontent.FuzzParseOEmbed"}},
	"safefetch.(*Fetcher).readBody": {Source: "fetched response bodies (gzip)", Targets: []string{"safefetch.FuzzReadBody"}},
	"safefetch.ClassifyAddr":        {Source: "addresses resolved from user-supplied URLs", Targets: []string{"safefetch.FuzzClassifyAddr"}, Manual: true},

	"service/discordimport.Decode":       {Source: "Discord export JSON", Targets: []string{"service/discordimport.FuzzDecode"}},
	"service/discordimport.NewZipExport": {Source: "Discord export archive", Targets: []string{"service/discordimport.FuzzNewZipExport"}},
	"service/discordimport.imageSize":    {Source: "Discord export images", Targets: []string{"service/discordimport.FuzzImageSize"}},

	"plugin.(*Registry).InstallFromZip": {Source: "plugin archive", Targets: []string{"plugin.FuzzInstallFromZip"}},

	"internal/archivebin.FromTarGz": {Source: "downloaded release and LiveKit archives", Targets: []string{"internal/archivebin.FuzzFromTarGz"}},
	"internal/archivebin.FromZip":   {Source: "downloaded LiveKit archive", Targets: []string{"internal/archivebin.FuzzFromZip"}},
}

// FuzzGaps are outside-input functions with no fuzz target yet. This table
// only shrinks: fuzzGapCeiling pins its size, and closing a gap moves the row
// to FuzzEntryPoints and lowers the ceiling by one.
var FuzzGaps = map[string]FuzzGap{
	"admin.decodeJSON":                  {Source: "admin REST bodies"},
	"admin.decodeOptionalJSON":          {Source: "admin REST bodies"},
	"admin.decodeStrictJSON":            {Source: "admin REST bodies"},
	"admin.handlePutAFKChannel":         {Source: "admin REST body field"},
	"api.decodeJSON":                    {Source: "REST bodies"},
	"api.decodeOptionalJSON":            {Source: "REST bodies"},
	"api.decodeStrictJSON":              {Source: "REST bodies"},
	"api.handleModerationNickname":      {Source: "REST body field"},
	"api.decodeGIFNext":                 {Source: "GIF provider response"},
	"api.fetchGIFs":                     {Source: "GIF provider response"},
	"api.(*PluginAdminHandler).install": {Source: "plugin upload (multipart)"},
	"api.handleCreateEmoji":             {Source: "emoji upload (multipart)"},
	"api.readEmojiUpload":               {Source: "emoji upload (multipart)"},
	"api.handleCreateSticker":           {Source: "sticker upload (multipart)"},
	"api.readStickerUpload":             {Source: "sticker upload (multipart)"},
	"api.handleUpload":                  {Source: "attachment upload (multipart)"},
	"api.readProfileImageForm":          {Source: "avatar, banner and group DM icon upload (multipart)"},
	"api.storedImageSize":               {Source: "uploaded images, read back from storage"},

	"ws.(*Hub).authenticateConn":  {Source: "WebSocket auth frame (FuzzAuthPayload checks a copy of its decode, not this function)"},
	"ws.authIdentityKey":          {Source: "WebSocket auth frame"},
	"ws.(*Hub).voiceJoinPrecheck": {Source: "voice_join payload"},

	"plugin.ParseManifest":             {Source: "plugin manifest"},
	"plugin.(*Registry).invokeCommand": {Source: "plugin output"},
	"plugin.listExportedCommands":      {Source: "plugin output"},

	"updater.(*Updater).fetchLatestRelease":    {Source: "GitHub release API response"},
	"updater.(*Updater).VerifyReleaseManifest": {Source: "downloaded release manifest"},
	"updater.(*Updater).ReleaseProtocolEpoch":  {Source: "downloaded release manifest"},
}

// fuzzGapCeiling is len(FuzzGaps). It only goes down.
const fuzzGapCeiling = 27

// FuzzTrustedDecodes decode bytes this server wrote itself (its database, its
// own frames and files) or files the operator owns. Each value says why the
// input is not outside data.
var FuzzTrustedDecodes = map[string]string{
	"admin.readLogFile":   "the server's own log file",
	"admin.supportDetail": "attributes of the server's own log records, read back from its database",

	"config.ReadOverrides":                       "the operator's override file",
	"internal/app.readBootMarker":                "a marker file the server wrote",
	"service.(*RetentionService).retentionClaim": "a retention claim the server stored",

	"db.ReadRestoreResult":       "a restore result file the server wrote",
	"db.readRestoreMarker":       "a restore marker the server wrote",
	"db.priorResult":             "a restore result file the server wrote",
	"db.appendErasureJobFiles":   "an erasure job row the server wrote",
	"db.eraseLockTx":             "an erasure job row the server wrote",
	"db.eraseFinishTx":           "an erasure job row the server wrote",
	"db.erasureJobFromRow":       "an erasure job row the server wrote",
	"db.appendRetentionRunBatch": "a retention run row the server wrote",
	"db.decodeRetentionRunLists": "a retention run row the server wrote",

	"ws.replayCopy":       "frames the server built",
	"ws.newReplaySplice":  "frames the server built",
	"ws.parseFrameRefs":   "frames the server built",
	"ws.payloadChannelID": "replayed events the server stored",
}
