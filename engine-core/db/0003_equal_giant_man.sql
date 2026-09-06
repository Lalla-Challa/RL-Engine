ALTER TABLE `chat_sessions` ADD `type` text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `status` text DEFAULT 'active' NOT NULL;