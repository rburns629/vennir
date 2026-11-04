// SPDX-License-Identifier: MIT

package dbsetup

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rburns629/vennir/kernel/internal/dbtest"
)

// The test server's superuser stands in for the managed server's
// administrator; the three roles for the kernel's, console's and gateway's.
func TestEachServiceGetsItsOwnDatabaseAndNoOther(t *testing.T) {
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, dbtest.URL())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	suffix := fmt.Sprint(time.Now().UnixNano())
	kernelDB, consoleDB := "setup_kernel_"+suffix, "setup_console_"+suffix
	kernel, console, gateway := "setup_k_"+suffix, "setup_c_"+suffix, "setup_g_"+suffix
	for _, s := range []string{
		"CREATE DATABASE " + kernelDB, "CREATE DATABASE " + consoleDB,
		"CREATE ROLE " + kernel + " LOGIN", "CREATE ROLE " + console + " LOGIN", "CREATE ROLE " + gateway + " LOGIN",
	} {
		if _, err := admin.Exec(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		for _, s := range []string{
			"DROP DATABASE IF EXISTS " + kernelDB + " WITH (FORCE)", "DROP DATABASE IF EXISTS " + consoleDB + " WITH (FORCE)",
			"DROP ROLE IF EXISTS " + kernel, "DROP ROLE IF EXISTS " + console, "DROP ROLE IF EXISTS " + gateway,
		} {
			_, _ = admin.Exec(context.Background(), s)
		}
	})
	as := func(role, database string) (*pgx.Conn, error) {
		config, err := pgx.ParseConfig(dbtest.URL())
		if err != nil {
			return nil, err
		}
		config.User, config.Database = role, database
		return pgx.ConnectConfig(ctx, config)
	}
	connect := func(ctx context.Context, database string) (*pgx.Conn, error) {
		return as(admin.Config().User, database)
	}
	// As an earlier setup granted it: everything passable on.
	if _, err := admin.Exec(ctx, "GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "+consoleDB+" TO "+console+" WITH GRANT OPTION"); err != nil {
		t.Fatal(err)
	}
	setup := Setup{Grants: []Grant{{Database: kernelDB, Role: kernel}, {Database: consoleDB, Role: console, Regrant: true}}}
	for range 2 { // again: no change, no error
		if err := Run(ctx, connect, admin.Config().Database, setup); err != nil {
			t.Fatal(err)
		}
	}

	run := func(role, database string, statements ...string) error {
		conn, err := as(role, database)
		if err != nil {
			return err
		}
		defer conn.Close(ctx)
		for _, s := range statements {
			if _, err := conn.Exec(ctx, s); err != nil {
				return err
			}
		}
		return nil
	}
	refused := func(err error) bool { return err != nil && strings.Contains(err.Error(), "permission denied") }

	if err := run(kernel, kernelDB, "CREATE TABLE tasks (id int)"); err != nil {
		t.Fatalf("the kernel in its own database: %v", err)
	}
	// The console migrates its own, and gives the gateway what it reads.
	if err := run(console, consoleDB,
		"CREATE TABLE users (id int)",
		"GRANT CONNECT ON DATABASE "+consoleDB+" TO "+gateway,
		"GRANT USAGE ON SCHEMA public TO "+gateway,
		"GRANT SELECT ON users TO "+gateway,
	); err != nil {
		t.Fatalf("the console in its own database: %v", err)
	}
	if err := run(gateway, consoleDB, "SELECT * FROM users"); err != nil {
		t.Fatalf("the gateway reading what it was given: %v", err)
	}
	// The console may pass on what it gives the gateway, and nothing more.
	inConsoleDB, err := as(admin.Config().User, consoleDB)
	if err != nil {
		t.Fatal(err)
	}
	defer inConsoleDB.Close(ctx)
	for privilege, want := range map[string]bool{
		"database CONNECT": true, "database CREATE": false, "database TEMPORARY": false,
		"schema USAGE": true, "schema CREATE": false,
	} {
		kind, name, _ := strings.Cut(privilege, " ")
		var can, has bool
		query := "SELECT has_database_privilege($1, $2, $3 || ' WITH GRANT OPTION'), has_database_privilege($1, $2, $3)"
		args := []any{console, consoleDB, name}
		if kind == "schema" {
			query = "SELECT has_schema_privilege($1, 'public', $2 || ' WITH GRANT OPTION'), has_schema_privilege($1, 'public', $2)"
			args = []any{console, name}
		}
		if err := inConsoleDB.QueryRow(ctx, query, args...).Scan(&can, &has); err != nil {
			t.Fatal(err)
		}
		if can != want || !has {
			t.Errorf("%s: passable on %v (want %v), held %v", privilege, can, want, has)
		}
	}
	// And no one in anyone else's.
	for _, c := range []struct{ role, database string }{{console, kernelDB}, {gateway, kernelDB}, {kernel, consoleDB}} {
		if err := run(c.role, c.database, "SELECT 1"); !refused(err) {
			t.Errorf("%s in %s: %v, want permission denied", c.role, c.database, err)
		}
	}
}

// On RDS the databases and roles aren't the cloud's: setup makes what's
// missing, members of what they need, and again changes nothing.
func TestMissingDatabasesAndRolesAreMade(t *testing.T) {
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, dbtest.URL())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	suffix := fmt.Sprint(time.Now().UnixNano())
	db, role, group := "made_db_"+suffix, "made_role_"+suffix, "made_group_"+suffix
	if _, err := admin.Exec(ctx, "CREATE ROLE "+group); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, s := range []string{"DROP DATABASE IF EXISTS " + db + " WITH (FORCE)", "DROP ROLE IF EXISTS " + role, "DROP ROLE IF EXISTS " + group} {
			_, _ = admin.Exec(context.Background(), s)
		}
	})
	connect := func(ctx context.Context, database string) (*pgx.Conn, error) {
		config, err := pgx.ParseConfig(dbtest.URL())
		if err != nil {
			return nil, err
		}
		config.Database = database
		return pgx.ConnectConfig(ctx, config)
	}
	setup := Setup{Databases: []string{db}, Roles: []Role{{Name: role, MemberOf: []string{group}}}, Grants: []Grant{{Database: db, Role: role}}}
	for range 2 {
		if err := Run(ctx, connect, admin.Config().Database, setup); err != nil {
			t.Fatal(err)
		}
	}
	var member, login bool
	if err := admin.QueryRow(ctx, "SELECT pg_has_role($1, $2, 'MEMBER'), (SELECT rolcanlogin FROM pg_roles WHERE rolname = $1)", role, group).Scan(&member, &login); err != nil || !member || !login {
		t.Errorf("role: member %v, login %v, %v", member, login, err)
	}
}
