ALTER TABLE "products" ADD COLUMN "clouds" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "clouds_from" text DEFAULT '' NOT NULL;