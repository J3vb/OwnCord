package db

// pending_migrations.go: the boot-time pre-migration backup gate's input,
// split out of migrate.go for its file-size limit; it shares that file's
// schema_versions helpers.

import "github.com/J3vb/OwnCord/Server/migrations"

// PendingMigrations reports the embedded migrations a boot will execute
// against the current schema, the input to the boot-time pre-migration backup
// gate. It returns none where no migration SQL runs: a fresh database (nothing
// to protect) and a pre-tracking database being seeded (recorded, not
// executed). A partly migrated database returns the remainder, exactly when the
// schema is about to move against real data. It reads schema_versions directly
// rather than via migrateFSCount, so it is safe to call before the migration
// runs.
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
