ALTER TABLE "product_releases" ADD COLUMN "last_used_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "product_releases" SET "last_used_at" = "registered_at";
