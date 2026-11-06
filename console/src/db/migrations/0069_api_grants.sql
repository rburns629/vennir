CREATE TABLE "api_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_by" uuid,
	"reason" text NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"decided_by" uuid,
	"decision_reason" text,
	"grant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "api_access_requests_state" CHECK ("api_access_requests"."state" IN ('waiting', 'granted', 'declined', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "api_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_id" uuid NOT NULL,
	"group_name" text,
	"user_id" uuid,
	"per_minute" integer,
	"granted_by" uuid,
	"from_request" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "api_grants_one_principal" CHECK (("api_grants"."group_name" IS NULL) <> ("api_grants"."user_id" IS NULL)),
	CONSTRAINT "api_grants_group_lowercase" CHECK ("api_grants"."group_name" = lower("api_grants"."group_name")),
	CONSTRAINT "api_grants_per_minute" CHECK ("api_grants"."per_minute" IS NULL OR "api_grants"."per_minute" > 0)
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"user_id" uuid NOT NULL,
	"group_name" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_groups_user_id_group_name_pk" PRIMARY KEY("user_id","group_name")
);
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN "access_requests" text DEFAULT 'approval' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_access_requests" ADD CONSTRAINT "api_access_requests_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_access_requests" ADD CONSTRAINT "api_access_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_access_requests" ADD CONSTRAINT "api_access_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_access_requests" ADD CONSTRAINT "api_access_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_access_requests" ADD CONSTRAINT "api_access_requests_grant_id_api_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."api_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_grants" ADD CONSTRAINT "api_grants_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_grants" ADD CONSTRAINT "api_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_grants" ADD CONSTRAINT "api_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_grants" ADD CONSTRAINT "api_grants_from_request_api_access_requests_id_fk" FOREIGN KEY ("from_request") REFERENCES "public"."api_access_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_grants" ADD CONSTRAINT "api_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_access_requests_one_waiting" ON "api_access_requests" USING btree ("api_id","user_id") WHERE state = 'waiting';--> statement-breakpoint
CREATE INDEX "api_access_requests_user_idx" ON "api_access_requests" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_grants_active_group" ON "api_grants" USING btree ("api_id","group_name") WHERE revoked_at IS NULL AND group_name IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "api_grants_active_user" ON "api_grants" USING btree ("api_id","user_id") WHERE revoked_at IS NULL AND user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "api_grants_user_idx" ON "api_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_groups_group_idx" ON "user_groups" USING btree ("group_name");