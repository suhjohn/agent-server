PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`internal_session_id` text DEFAULT '' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`agent` text DEFAULT 'claude-code' NOT NULL,
	`cwd` text NOT NULL,
	`model` text DEFAULT 'anthropic/claude-4-sonnet-20250514' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "internal_session_id", "name", "agent", "cwd", "model", "created_at", "updated_at") SELECT "id", "internal_session_id", "name", "agent", "cwd", "model", "created_at", "updated_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;