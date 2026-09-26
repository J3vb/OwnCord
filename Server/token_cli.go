package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"text/tabwriter"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// runTokenCLI implements `server token <create|list|revoke>`. It operates
// directly against the database — no HTTP, no login — so an operator can mint
// the first API token without any existing credential (the bootstrap path).
// Returns a process exit code.
func runTokenCLI(args []string) int {
	if len(args) == 0 {
		tokenUsage()
		return 2
	}

	cfg, err := config.Load(config.DefaultPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: load config: %v\n", err)
		return 1
	}
	// OpenShared: the CLI must work while the server is running (the docs'
	// cron-backup recipe mints tokens against a live server). SQLite WAL makes
	// the concurrent access safe; the single-process lock protects only the
	// server's process-local state, which this CLI never touches.
	database, err := db.OpenShared(cfg.Database.Path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: open database: %v\n", err)
		return 1
	}
	defer database.Close() //nolint:errcheck
	// Idempotent: ensures the api_tokens table exists even if the server has
	// never started against this database.
	if err := db.Migrate(database); err != nil {
		fmt.Fprintf(os.Stderr, "error: migrate: %v\n", err)
		return 1
	}

	ctx := context.Background()
	// The CLI holds the handle (it opens and migrates its own database) but
	// makes no query of its own: the three subcommands are adapters over the
	// same TokenService the admin panel uses, which is what keeps the two from
	// drifting apart again.
	tokens := service.NewTokenService(database)
	switch args[0] {
	case "create":
		return tokenCreate(ctx, tokens, args[1:])
	case "list":
		return tokenList(ctx, tokens, args[1:])
	case "revoke":
		return tokenRevoke(ctx, tokens, args[1:])
	default:
		fmt.Fprintf(os.Stderr, "unknown token subcommand %q\n", args[0])
		tokenUsage()
		return 2
	}
}

func tokenUsage() {
	fmt.Fprint(os.Stderr, `usage: server token <command>

Commands:
  create --label <name> [--user <username>] [--expires <dur>]
        Mint a new API token. Prints the raw token once to stdout — store it
        now, it is never recoverable. Defaults to the owner account and no
        expiry. --expires accepts a Go duration, e.g. 720h.
  list
        List API tokens (never prints raw tokens).
  revoke <id|label>
        Revoke a token by numeric id, or by label — an all-digit argument is
        tried as an id first and as a label when no active token has that id.
`)
}

func tokenCreate(ctx context.Context, tokens *service.TokenService, args []string) int {
	fs := flag.NewFlagSet("token create", flag.ContinueOnError)
	label := fs.String("label", "", "human-readable label (required)")
	username := fs.String("user", "", "username to bind the token to (default: owner)")
	expires := fs.Duration("expires", 0, "validity duration, e.g. 720h (default: never)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *label == "" {
		fmt.Fprintln(os.Stderr, "error: --label is required")
		return 2
	}

	// ActorSelf attributes the audit row to the token's bound user rather than
	// to an operator: this command runs with no credential at all (it is the
	// bootstrap path), so there is no actor identity to record. The panel's
	// route, which does have one, records that instead.
	minted, err := tokens.Create(ctx, service.ActorSelf, *username, *label, *expires)
	switch {
	case errors.Is(err, service.ErrNotFound):
		fmt.Fprintf(os.Stderr, "error: no user named %q\n", *username)
		return 1
	case errors.Is(err, service.ErrNoOwnerAccount):
		fmt.Fprintln(os.Stderr, "error: no users exist yet — create the owner account first")
		return 1
	case errors.Is(err, service.ErrBadRequest):
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 2
	case err != nil:
		fmt.Fprintf(os.Stderr, "error: create token: %v\n", err)
		return 1
	}

	// Metadata to stderr, raw token alone to stdout — so `... | tail -1` or a
	// capture pipe gets exactly the token.
	fmt.Fprintf(os.Stderr, "Created API token #%d for user %q (label %q).\n", minted.ID, minted.User.Username, minted.Label)
	fmt.Fprintln(os.Stderr, "Store this token now — it is shown only once:")
	fmt.Println(minted.Raw)
	return 0
}

func tokenList(ctx context.Context, tokens *service.TokenService, args []string) int {
	fs := flag.NewFlagSet("token list", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	list, err := tokens.List(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: list tokens: %v\n", err)
		return 1
	}
	if len(list) == 0 {
		fmt.Println("no API tokens")
		return 0
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	// Buffer-write errors surface via tw.Flush() below, which is checked.
	_, _ = fmt.Fprintln(tw, "ID\tUSER\tLABEL\tCREATED\tLAST USED\tEXPIRES\tREVOKED")
	for _, t := range list {
		_, _ = fmt.Fprintf(tw, "%d\t%s\t%s\t%s\t%s\t%s\t%s\n",
			t.ID, t.Username, t.Label, t.CreatedAt,
			orDash(t.LastUsed), orDash(t.ExpiresAt), orDash(t.RevokedAt))
	}
	if err := tw.Flush(); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	return 0
}

func tokenRevoke(ctx context.Context, tokens *service.TokenService, args []string) int {
	fs := flag.NewFlagSet("token revoke", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	rest := fs.Args()
	if len(rest) != 1 {
		fmt.Fprintln(os.Stderr, "error: revoke takes exactly one argument (id or label)")
		return 2
	}
	arg := rest[0]

	// An argument that parses as an integer is tried as an id first; when no
	// active token carries that id it is tried as a label, because labels are
	// free text and an all-digit one is legal (OC-0341). Anything else is a
	// label. Revoking by label is the CLI's own form — an operator recovering
	// a compromised credential knows what they typed, not the row id — and
	// the id keeps precedence, as the usage text says.
	var (
		affected int64
		err      error
	)
	if id, perr := strconv.ParseInt(arg, 10, 64); perr == nil {
		if err = tokens.Revoke(ctx, 0, id); err == nil {
			affected = 1
		} else if errors.Is(err, service.ErrNotFound) {
			affected, err = tokens.RevokeByLabel(ctx, 0, arg)
		}
	} else {
		affected, err = tokens.RevokeByLabel(ctx, 0, arg)
	}
	switch {
	case errors.Is(err, service.ErrNotFound):
		fmt.Fprintf(os.Stderr, "no active token matched %q\n", arg)
		return 1
	case err != nil:
		fmt.Fprintf(os.Stderr, "error: revoke token: %v\n", err)
		return 1
	}
	fmt.Printf("revoked %d token(s)\n", affected)
	return 0
}

// orDash renders a nullable timestamp column for the list table.
func orDash(s *string) string {
	if s == nil || *s == "" {
		return "-"
	}
	return *s
}
