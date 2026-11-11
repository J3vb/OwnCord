package service

import (
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Store is what New needs to build every service: the union of each service's own
// interface plus the slices New hands to services that already took one. Only New takes
// Store (TestStoreConsumers); each service takes its own interface.
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
