package db

// pending_migrations.go — the boot-time pre-migration backup gate's input.
// Split out of migrate.go so that file stays under the file-size limit;
// it shares migrate.go's schema_versions helpers.

import "github.com/J3vb/OwnCord/Server/migrations"

// PendingMigrations reports the embedded migrations a boot will execute
// against the current on-disk schema — the input to the boot-time
// pre-migration backup gate. It returns none for the two cases that run
// no migration SQL: a fresh database (nothing to protect, and the seeding
// path never fires) and a pre-tracking database being seeded (its migration
// set is recorded without being executed). A partially migrated database
// returns the remainder, which is exactly when the schema is about to move
// against real data.
//
// It reads schema_versions directly rather than calling migrateFSCount, so it
// is safe to call BEFORE the migration runs — which is the whole point.
func PendingMigrations(database *DB) ([]string, error) {
	filenames, err := sqlFilenames(migrations.FS)
	if err != nil {
		return nil, err
	}

	svExists, err := schemaVersionsExists(database)
	if err != nil {
		return nil, err
	}
	if !svExists {
		// No tracking yet: either a fresh database (nothing exists to
		// protect) or a pre-tracking one (seedExistingDatabase records the
		// filenames without running any SQL). Neither moves the schema.
		return nil, nil
	}

	recorded, err := recordedSchemaVersions(database)
	if err != nil {
		return nil, err
	}
	applied := make(map[string]struct{}, len(recorded))
	for _, v := range recorded {
		applied[v] = struct{}{}
	}
	var pending []string
	for _, name := range filenames {
		if _, ok := applied[name]; !ok {
			pending = append(pending, name)
		}
	}
	return pending, nil
}
