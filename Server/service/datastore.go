package service

import (
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Store is what New needs to build every service: the union of the interface
// each service declares beside its own type (blockStore in block.go, and so
// on), plus the slices New hands to the services that already took one.
// *db.DB satisfies it. A service takes only its own interface, so a test fake
// for it implements only the methods that service calls; nothing but New takes
// Store (TestStoreConsumers).
type Store interface {
	appealStore
	authStore
	blockStore
	callLogServiceStore
	channelStore
	connWritesStore
	dmStore
	gifFavoriteStore
	inviteStore
	messageRequestStore
	messageServiceStore
	moderationStore
	nsfwStore
	permissionStore
	pushDispatchStore
	pushStore
	reportStore
	roleStore
	sessionStore
	settingsStore
	setupStore
	threadServiceStore
	tokenStore
	uploadStore
	userStore
	voiceStore
	welcomeServiceStore

	ChannelPrivacyStore
	customStatusExpiryStore
	EmojiStore
	ErasureStore
	RetentionStore
	permissions.DB
}
