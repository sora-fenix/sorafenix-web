CREATE TYPE "public"."scrape_tier" AS ENUM('burst', 'steady', 'maintenance');--> statement-breakpoint
CREATE TABLE "scrape_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"space_fingerprint" text NOT NULL,
	"space_size" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"lap" integer DEFAULT 0 NOT NULL,
	"lap_started_on" date NOT NULL,
	"last_planned_on" date,
	"tier" "scrape_tier" DEFAULT 'burst' NOT NULL,
	"tier_changed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scrape_cursors" ADD CONSTRAINT "scrape_cursors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_cursors" ADD CONSTRAINT "scrape_cursors_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scrape_cursors_campaign_key" ON "scrape_cursors" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "scrape_cursors_workspace_idx" ON "scrape_cursors" USING btree ("workspace_id");