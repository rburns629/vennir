// SPDX-License-Identifier: MIT

package migrate

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// PolicyReads and PolicyWrites are the tables `kernel policy` uses
// (decision 27): it reads which migrations ran, and which steps are
// unfinished, and keeps the catalog's releases. Nothing else.
var (
	PolicyReads  = []string{"schema_migrations", "executions", "execution_tasks"}
	PolicyWrites = []string{"catalog_policy_state", "catalog_policy_releases"}
)

// GrantPolicy gives `kernel policy`'s own role (CATALOG_POLICY_DATABASE_ROLE)
// what it uses and nothing else, as the tables' owner, after Run: CONNECT
// on this database, USAGE on its public schema, SELECT on PolicyReads, and
// SELECT, INSERT, UPDATE and DELETE on PolicyWrites. Whatever else it was
// given on a table here is taken back first, so running it again changes
// nothing, and a table dropped from the lists stops being its. The role
// must exist: the chart's migration Job makes it with the bundled
// Postgres, the cloud makes it with a managed one.
func GrantPolicy(ctx context.Context, conn Conn, role string) error {
	who := pgx.Identifier{role}.Sanitize()
	return pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		var database string
		if err := tx.QueryRow(ctx, `SELECT current_database()`).Scan(&database); err != nil {
			return err
		}
		statements := []string{
			fmt.Sprintf("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %s", who),
			fmt.Sprintf("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %s", who),
			fmt.Sprintf("GRANT CONNECT ON DATABASE %s TO %s", pgx.Identifier{database}.Sanitize(), who),
			fmt.Sprintf("GRANT USAGE ON SCHEMA public TO %s", who),
		}
		for _, table := range PolicyReads {
			statements = append(statements, fmt.Sprintf("GRANT SELECT ON %s TO %s", pgx.Identifier{table}.Sanitize(), who))
		}
		for _, table := range PolicyWrites {
			statements = append(statements, fmt.Sprintf("GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO %s", pgx.Identifier{table}.Sanitize(), who))
		}
		for _, statement := range statements {
			if _, err := tx.Exec(ctx, statement); err != nil {
				return fmt.Errorf("%s: %w", statement, err)
			}
		}
		return nil
	})
}
