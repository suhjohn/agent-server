ALTER TABLE `sessions` ADD `internal_session_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `agent` text DEFAULT 'claude-code' NOT NULL;