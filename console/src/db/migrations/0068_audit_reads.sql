CREATE TABLE "audit_reads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"route" text NOT NULL,
	"execution_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"teams" text[] DEFAULT '{}'::text[] NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_ip" text,
	"request_id" text
);
--> statement-breakpoint
CREATE INDEX "audit_reads_at_idx" ON "audit_reads" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_reads_actor_idx" ON "audit_reads" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_reads_executions_idx" ON "audit_reads" USING gin ("execution_ids");--> statement-breakpoint
CREATE INDEX "audit_reads_teams_idx" ON "audit_reads" USING gin ("teams");