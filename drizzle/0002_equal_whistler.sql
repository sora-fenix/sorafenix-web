CREATE TYPE "public"."activity_actor" AS ENUM('ai', 'human', 'system');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'running', 'paused', 'done');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('unknown', 'valid', 'invalid', 'bounced');--> statement-breakpoint
CREATE TYPE "public"."lead_category" AS ENUM('hot', 'warm', 'cold');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'qualified', 'contacted', 'replied', 'interested', 'meeting', 'proposal', 'negotiation', 'won', 'lost', 'do_not_contact');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('gmail', 'whatsapp', 'serper');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('connected', 'disconnected', 'error');--> statement-breakpoint
CREATE TYPE "public"."knowledge_doc_type" AS ENUM('company_profile', 'catalog', 'pricelist', 'faq', 'case_study', 'script', 'objection', 'tnc');--> statement-breakpoint
CREATE TYPE "public"."message_channel" AS ENUM('email', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('out', 'in');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('draft', 'needs_input', 'pending_approval', 'approved', 'queued', 'sent', 'delivered', 'opened', 'replied', 'bounced', 'failed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."sequence_state" AS ENUM('active', 'paused', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."suppression_kind" AS ENUM('email', 'phone', 'domain');--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"ok" boolean NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid,
	"type" text NOT NULL,
	"channel" text,
	"payload" jsonb,
	"actor" "activity_actor" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"product_id" uuid,
	"target" jsonb,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"daily_cap" integer DEFAULT 50 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"website" text,
	"industry" text,
	"city" text,
	"country" text DEFAULT 'ID',
	"size_band" text,
	"employee_count" integer,
	"description" text,
	"source" text,
	"source_url" text,
	"raw" jsonb,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"company_id" uuid,
	"name" text,
	"position" text,
	"department" text,
	"email" text,
	"phone" text,
	"whatsapp" text,
	"source" text,
	"email_status" "email_status" DEFAULT 'unknown' NOT NULL,
	"opt_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid,
	"company_id" uuid,
	"contact_id" uuid,
	"score" integer,
	"category" "lead_category",
	"score_factors" jsonb,
	"score_reason" text,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"owner_id" uuid,
	"last_activity_at" timestamp with time zone,
	"next_action_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"credentials_encrypted" text,
	"status" "integration_status" DEFAULT 'disconnected' NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "knowledge_doc_type" NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"file_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"value_prop" text,
	"icp" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid,
	"channel" "message_channel" NOT NULL,
	"direction" "message_direction" NOT NULL,
	"status" "message_status" DEFAULT 'draft' NOT NULL,
	"subject" text,
	"body" text,
	"template_id" text,
	"provider_message_id" text,
	"thread_id" text,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"approved_by" uuid,
	"reject_reason" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"sequence_id" text DEFAULT 'default' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone,
	"state" "sequence_state" DEFAULT 'active' NOT NULL,
	"stop_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "suppression_kind" NOT NULL,
	"value" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_docs" ADD CONSTRAINT "knowledge_docs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_runs_workspace_created_idx" ON "ai_runs" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_runs_workspace_agent_idx" ON "ai_runs" USING btree ("workspace_id","agent");--> statement-breakpoint
CREATE INDEX "activities_workspace_lead_created_idx" ON "activities" USING btree ("workspace_id","lead_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activities_workspace_created_idx" ON "activities" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "campaigns_workspace_status_idx" ON "campaigns" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_workspace_domain_key" ON "companies" USING btree ("workspace_id","domain") WHERE "companies"."domain" is not null;--> statement-breakpoint
CREATE INDEX "companies_workspace_dedupe_key_idx" ON "companies" USING btree ("workspace_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "companies_workspace_city_idx" ON "companies" USING btree ("workspace_id","city");--> statement-breakpoint
CREATE INDEX "contacts_workspace_email_idx" ON "contacts" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "contacts_workspace_phone_idx" ON "contacts" USING btree ("workspace_id","phone");--> statement-breakpoint
CREATE INDEX "contacts_company_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "leads_workspace_status_idx" ON "leads" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "leads_next_action_at_idx" ON "leads" USING btree ("next_action_at");--> statement-breakpoint
CREATE INDEX "leads_workspace_campaign_idx" ON "leads" USING btree ("workspace_id","campaign_id");--> statement-breakpoint
CREATE INDEX "leads_workspace_owner_idx" ON "leads" USING btree ("workspace_id","owner_id");--> statement-breakpoint
CREATE INDEX "leads_workspace_score_idx" ON "leads" USING btree ("workspace_id","score");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_campaign_contact_key" ON "leads" USING btree ("campaign_id","contact_id") WHERE "leads"."campaign_id" is not null and "leads"."contact_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_workspace_provider_key" ON "integrations" USING btree ("workspace_id","provider");--> statement-breakpoint
CREATE INDEX "knowledge_docs_workspace_type_idx" ON "knowledge_docs" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE INDEX "products_workspace_idx" ON "products" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_workspace_idempotency_key" ON "messages" USING btree ("workspace_id","idempotency_key") WHERE "messages"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "messages_workspace_status_idx" ON "messages" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "messages_workspace_lead_created_idx" ON "messages" USING btree ("workspace_id","lead_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "messages_provider_message_idx" ON "messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "sequence_runs_due_idx" ON "sequence_runs" USING btree ("next_run_at") WHERE "sequence_runs"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_runs_lead_sequence_key" ON "sequence_runs" USING btree ("lead_id","sequence_id");--> statement-breakpoint
CREATE INDEX "sequence_runs_workspace_state_idx" ON "sequence_runs" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_workspace_kind_value_key" ON "suppressions" USING btree ("workspace_id","kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_idempotency_key" ON "webhook_events" USING btree ("provider","idempotency_key");--> statement-breakpoint
CREATE INDEX "webhook_events_workspace_created_idx" ON "webhook_events" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");