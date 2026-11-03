// SPDX-License-Identifier: MIT

// Package dbsetup prepares a managed database server's databases for
// their services, once per install, as an administrator: on RDS it first
// makes the databases and the services' login roles (Cloud SQL's are the
// cloud's); then each database is
// opened to its own service alone (CONNECT and CREATE on it and its public
// schema), and to no one else (PUBLIC's default CONNECT is revoked). The
// services then make and own their own tables, as with the in-cluster
// Postgres; none can read another's. The console may pass on CONNECT and
// the schema's USAGE alone (the grant option), so its migration can give
// the gateway what it reads (console/src/db/gatewayAccess.ts); its tables
// it owns. Running it again changes nothing.
package dbsetup

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Grant is one database and the role it's opened to.
type Grant struct {
	Database string
	Role     string
	// Regrant: the role may pass on CONNECT and the schema's USAGE (the
	// console, to the gateway), and nothing else it's given.
	Regrant bool
}

// Role is a login role to make when it's missing (on RDS, whose users the
// cloud doesn't make), and the roles it's a member of (rds_iam, for its
// IAM sign-in).
type Role struct {
	Name     string   `json:"name"`
	MemberOf []string `json:"memberOf,omitempty"`
}

// Setup is everything database-setup does: the databases to make when
// missing, the roles likewise, then the grants.
type Setup struct {
	Databases []string
	Roles     []Role
	Grants    []Grant
}

// Connect opens a connection to a database by name, as the administrator.
type Connect func(ctx context.Context, database string) (*pgx.Conn, error)

// Run makes what's missing, then applies each grant: the database's
// privileges from the server's maintenance database, its public schema's
// from the database itself.
func Run(ctx context.Context, connect Connect, maintenance string, setup Setup) error {
	admin, err := connect(ctx, maintenance)
	if err != nil {
		return err
	}
	defer admin.Close(context.WithoutCancel(ctx))
	if err := prepare(ctx, admin, setup); err != nil {
		return err
	}
	for _, g := range setup.Grants {
		database, role := pgx.Identifier{g.Database}.Sanitize(), pgx.Identifier{g.Role}.Sanitize()
		statements := []string{
			fmt.Sprintf("REVOKE ALL ON DATABASE %s FROM PUBLIC", database),
			// What an earlier setup let it pass on, and nothing passes on now.
			fmt.Sprintf("REVOKE GRANT OPTION FOR CREATE, TEMPORARY ON DATABASE %s FROM %s", database, role),
			fmt.Sprintf("GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %s TO %s", database, role),
		}
		if g.Regrant {
			// Only what the console gives the gateway's role.
			statements = append(statements, fmt.Sprintf("GRANT CONNECT ON DATABASE %s TO %s WITH GRANT OPTION", database, role))
		}
		for _, statement := range statements {
			if _, err := admin.Exec(ctx, statement); err != nil {
				return fmt.Errorf("%s: %w", g.Database, err)
			}
		}
		if err := grantSchema(ctx, connect, g, role); err != nil {
			return err
		}
	}
	return nil
}

// prepare makes the databases and roles that are missing.
func prepare(ctx context.Context, admin *pgx.Conn, setup Setup) error {
	exists := func(query, name string) (bool, error) {
		var found bool
		err := admin.QueryRow(ctx, "SELECT EXISTS ("+query+")", name).Scan(&found)
		return found, err
	}
	for _, d := range setup.Databases {
		found, err := exists("SELECT FROM pg_database WHERE datname = $1", d)
		if err != nil {
			return err
		}
		if !found {
			if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{d}.Sanitize()); err != nil {
				return fmt.Errorf("making database %s: %w", d, err)
			}
		}
	}
	for _, r := range setup.Roles {
		found, err := exists("SELECT FROM pg_roles WHERE rolname = $1", r.Name)
		if err != nil {
			return err
		}
		role := pgx.Identifier{r.Name}.Sanitize()
		if !found {
			if _, err := admin.Exec(ctx, "CREATE ROLE "+role+" LOGIN"); err != nil {
				return fmt.Errorf("making role %s: %w", r.Name, err)
			}
		}
		for _, m := range r.MemberOf {
			if _, err := admin.Exec(ctx, "GRANT "+pgx.Identifier{m}.Sanitize()+" TO "+role); err != nil {
				return fmt.Errorf("making %s a member of %s: %w", r.Name, m, err)
			}
		}
	}
	return nil
}

func grantSchema(ctx context.Context, connect Connect, g Grant, role string) error {
	conn, err := connect(ctx, g.Database)
	if err != nil {
		return err
	}
	defer conn.Close(context.WithoutCancel(ctx))
	statements := []string{
		"REVOKE GRANT OPTION FOR CREATE ON SCHEMA public FROM " + role,
		"GRANT USAGE, CREATE ON SCHEMA public TO " + role,
	}
	if g.Regrant {
		statements = append(statements, "GRANT USAGE ON SCHEMA public TO "+role+" WITH GRANT OPTION")
	}
	for _, statement := range statements {
		if _, err := conn.Exec(ctx, statement); err != nil {
			return fmt.Errorf("%s's public schema: %w", g.Database, err)
		}
	}
	return nil
}
