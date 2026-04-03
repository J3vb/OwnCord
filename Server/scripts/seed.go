// seed.go is a standalone tool that populates an OwnCord database with
// development data (users, channels, messages, DMs). It is idempotent:
// running it multiple times against the same database is safe.
//
// Usage:
//
//	go run scripts/seed.go                         # uses ./data/chatserver.db
//	go run scripts/seed.go -db path/to/owncord.db  # custom path
package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// ─── Seed data definitions ──────────────────────────────────────────────────

// seedUser defines a user to create during seeding.
type seedUser struct {
	Username string
	Password string
	RoleID   int // 1=Owner, 2=Admin, 3=Moderator, 4=Member
}

// seedChannel defines a channel to create during seeding.
type seedChannel struct {
	Name     string
	Type     string // "text" or "voice"
	Category string
	Topic    string
	Position int
}

// seedMessage defines a message to insert during seeding.
// ChannelIdx and UserIdx refer to zero-based indices into the channels and
// users slices (resolved after creation).
type seedMessage struct {
	ChannelIdx int
	UserIdx    int
	Content    string
}

var seedUsers = []seedUser{
	{Username: "admin", Password: "admin123", RoleID: 1},
	{Username: "alice", Password: "password123", RoleID: 4},
	{Username: "bob", Password: "password123", RoleID: 4},
	{Username: "charlie", Password: "password123", RoleID: 4},
}

var seedChannels = []seedChannel{
	{Name: "general", Type: "text", Category: "Text Channels", Topic: "General chat", Position: 0},
	{Name: "random", Type: "text", Category: "Text Channels", Topic: "Off-topic discussion", Position: 1},
	{Name: "gaming", Type: "text", Category: "Text Channels", Topic: "Gaming talk", Position: 2},
	{Name: "Voice Lounge", Type: "voice", Category: "Voice Channels", Position: 3},
	{Name: "Gaming Voice", Type: "voice", Category: "Voice Channels", Position: 4},
}

// Channel indices for readability.
const (
	chGeneral = 0
	chRandom  = 1
	chGaming  = 2
)

// User indices for readability.
const (
	uAdmin   = 0
	uAlice   = 1
	uBob     = 2
	uCharlie = 3
)

var seedMessages = []seedMessage{
	// #general
	{chGeneral, uAdmin, "Welcome to OwnCord! This is the general channel."},
	{chGeneral, uAlice, "Hey everyone! Glad to be here."},
	{chGeneral, uBob, "Hello! This looks great."},
	{chGeneral, uCharlie, "Hi all, what's everyone up to?"},
	{chGeneral, uAdmin, "Feel free to chat about anything here."},
	{chGeneral, uAlice, "Anyone tried the voice chat yet?"},
	{chGeneral, uBob, "Not yet, but I'm about to!"},
	{chGeneral, uCharlie, "The UI looks really clean."},
	{chGeneral, uAdmin, "Thanks! We've been working hard on it."},
	{chGeneral, uAlice, "Can we customize themes?"},
	{chGeneral, uAdmin, "Yes! Check the settings panel."},

	// #random
	{chRandom, uBob, "Random thought: pineapple on pizza is underrated."},
	{chRandom, uCharlie, "Hard disagree, but I respect your opinion."},
	{chRandom, uAlice, "Let's not start a war here lol"},
	{chRandom, uBob, "Too late, the war has begun!"},
	{chRandom, uAdmin, "Keep it friendly, folks!"},
	{chRandom, uCharlie, "Anyone watching any good shows lately?"},
	{chRandom, uAlice, "I just finished a great series, highly recommend it."},
	{chRandom, uBob, "What series?"},
	{chRandom, uAlice, "I'll share the link later!"},

	// #gaming
	{chGaming, uCharlie, "Anyone up for some co-op tonight?"},
	{chGaming, uBob, "I'm down! What game?"},
	{chGaming, uCharlie, "Thinking something chill, maybe Minecraft?"},
	{chGaming, uAlice, "Count me in!"},
	{chGaming, uAdmin, "I might join later if I finish some work."},
	{chGaming, uBob, "No pressure, we'll be on for a while."},
}

// seedDMMessages are messages exchanged in the admin<->alice DM channel.
var seedDMMessages = []struct {
	FromIdx int // index into seedUsers
	Content string
}{
	{uAdmin, "Hey Alice, welcome to the server!"},
	{uAlice, "Thanks! Everything looks awesome."},
	{uAdmin, "Let me know if you run into any issues."},
	{uAlice, "Will do! One question: how do I change my avatar?"},
	{uAdmin, "Go to Settings > Account, you can upload one there."},
}

// ─── Main ───────────────────────────────────────────────────────────────────

func main() {
	dbPath := flag.String("db", "data/chatserver.db", "path to the SQLite database file")
	confirmDev := flag.Bool("confirm-dev", false, "confirm this is a development database (required)")
	flag.Parse()

	if !*confirmDev {
		fmt.Fprintln(os.Stderr, "⚠  This script creates users with weak passwords.")
		fmt.Fprintln(os.Stderr, "   Pass -confirm-dev to confirm this is a development database.")
		os.Exit(1)
	}

	log.SetFlags(0) // no timestamp prefix — keep output clean

	database, err := db.Open(*dbPath)
	if err != nil {
		log.Fatalf("failed to open database at %s: %v", *dbPath, err)
	}

	exitCode := run(database)
	_ = database.Close()
	os.Exit(exitCode)
}

func run(database *db.DB) int {
	if err := db.Migrate(database); err != nil {
		log.Printf("failed to run migrations: %v", err)
		return 1
	}

	userIDs, err := createUsers(database)
	if err != nil {
		log.Printf("failed to create users: %v", err)
		return 1
	}

	channelIDs, err := createChannels(database)
	if err != nil {
		log.Printf("failed to create channels: %v", err)
		return 1
	}

	msgCount, err := createMessages(database, channelIDs, userIDs)
	if err != nil {
		log.Printf("failed to create messages: %v", err)
		return 1
	}

	dmMsgCount, err := createDMConversation(database, userIDs)
	if err != nil {
		log.Printf("failed to create DM conversation: %v", err)
		return 1
	}

	fmt.Println("--- Seed complete ---")
	fmt.Printf("  Users:    %d\n", len(userIDs))
	fmt.Printf("  Channels: %d\n", len(channelIDs))
	fmt.Printf("  Messages: %d (channel) + %d (DM) = %d total\n",
		msgCount, dmMsgCount, msgCount+dmMsgCount)
	return 0
}

// ─── User creation ──────────────────────────────────────────────────────────

func createUsers(database *db.DB) ([]int64, error) {
	ids := make([]int64, len(seedUsers))

	for i, su := range seedUsers {
		existing, err := database.GetUserByUsername(su.Username)
		if err != nil {
			return nil, fmt.Errorf("checking user %q: %w", su.Username, err)
		}
		if existing != nil {
			ids[i] = existing.ID
			fmt.Printf("[skip] user %q already exists (id=%d)\n", su.Username, existing.ID)
			continue
		}

		hash, err := auth.HashPassword(su.Password)
		if err != nil {
			return nil, fmt.Errorf("hashing password for %q: %w", su.Username, err)
		}

		id, err := database.CreateUser(su.Username, hash, su.RoleID)
		if err != nil {
			return nil, fmt.Errorf("creating user %q: %w", su.Username, err)
		}

		ids[i] = id
		roleName := roleNameFromID(su.RoleID)
		fmt.Printf("[created] user %q (id=%d, role=%s)\n", su.Username, id, roleName)
	}

	return ids, nil
}

// roleNameFromID returns a human-readable role name for display purposes.
func roleNameFromID(roleID int) string {
	switch roleID {
	case 1:
		return "owner"
	case 2:
		return "admin"
	case 3:
		return "moderator"
	case 4:
		return "member"
	default:
		return fmt.Sprintf("role_%d", roleID)
	}
}

// ─── Channel creation ───────────────────────────────────────────────────────

func createChannels(database *db.DB) ([]int64, error) {
	ids := make([]int64, len(seedChannels))

	// Fetch existing channels once to check for duplicates.
	existing, err := database.ListChannels()
	if err != nil {
		return nil, fmt.Errorf("listing channels: %w", err)
	}
	existingByName := make(map[string]int64, len(existing))
	for i := range existing {
		existingByName[existing[i].Name] = existing[i].ID
	}

	for i, sc := range seedChannels {
		if id, found := existingByName[sc.Name]; found {
			ids[i] = id
			fmt.Printf("[skip] channel %q already exists (id=%d)\n", sc.Name, id)
			continue
		}

		id, err := database.CreateChannel(sc.Name, sc.Type, sc.Category, sc.Topic, sc.Position)
		if err != nil {
			return nil, fmt.Errorf("creating channel %q: %w", sc.Name, err)
		}

		ids[i] = id
		fmt.Printf("[created] channel %q (id=%d, type=%s)\n", sc.Name, id, sc.Type)
	}

	return ids, nil
}

// ─── Message creation ───────────────────────────────────────────────────────

func createMessages(database *db.DB, channelIDs, userIDs []int64) (int, error) {
	created := 0

	for _, sm := range seedMessages {
		channelID := channelIDs[sm.ChannelIdx]
		userID := userIDs[sm.UserIdx]

		// Check if this exact message already exists (content + user + channel).
		exists, err := messageExists(database, channelID, userID, sm.Content)
		if err != nil {
			return 0, fmt.Errorf("checking message existence: %w", err)
		}
		if exists {
			continue
		}

		if _, err := database.CreateMessage(channelID, userID, sm.Content, nil); err != nil {
			return 0, fmt.Errorf("creating message in channel %d: %w", channelID, err)
		}
		created++
	}

	if created > 0 {
		fmt.Printf("[created] %d channel messages\n", created)
	} else {
		fmt.Println("[skip] channel messages already seeded")
	}

	return created, nil
}

// messageExists checks whether a message with the given content from the given
// user already exists in the channel. Used for idempotency.
func messageExists(database *db.DB, channelID, userID int64, content string) (bool, error) {
	var count int
	err := database.QueryRow(
		`SELECT COUNT(*) FROM messages WHERE channel_id = ? AND user_id = ? AND content = ? AND deleted = 0`,
		channelID, userID, content,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// ─── DM conversation ────────────────────────────────────────────────────────

func createDMConversation(database *db.DB, userIDs []int64) (int, error) {
	adminID := userIDs[uAdmin]
	aliceID := userIDs[uAlice]

	ch, isNew, err := database.GetOrCreateDMChannel(adminID, aliceID)
	if err != nil {
		return 0, fmt.Errorf("creating DM channel: %w", err)
	}

	if isNew {
		fmt.Printf("[created] DM channel between admin and alice (id=%d)\n", ch.ID)
	} else {
		fmt.Printf("[skip] DM channel between admin and alice already exists (id=%d)\n", ch.ID)
	}

	created := 0
	for _, dm := range seedDMMessages {
		senderID := userIDs[dm.FromIdx]

		exists, err := messageExists(database, ch.ID, senderID, dm.Content)
		if err != nil {
			return 0, fmt.Errorf("checking DM message existence: %w", err)
		}
		if exists {
			continue
		}

		if _, err := database.CreateMessage(ch.ID, senderID, dm.Content, nil); err != nil {
			return 0, fmt.Errorf("creating DM message: %w", err)
		}
		created++
	}

	if created > 0 {
		fmt.Printf("[created] %d DM messages\n", created)
	} else {
		fmt.Println("[skip] DM messages already seeded")
	}

	return created, nil
}

// ─── Ensure data directory exists ───────────────────────────────────────────

func init() {
	// The default DB path is data/chatserver.db. Ensure the data directory
	// exists so db.Open doesn't fail on a fresh checkout.
	if err := os.MkdirAll("data", 0o750); err != nil {
		log.Printf("warning: could not create data directory: %v", err)
	}
}
