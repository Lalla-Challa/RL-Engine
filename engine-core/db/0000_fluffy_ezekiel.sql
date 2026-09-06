CREATE TABLE `activity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`eventType` text NOT NULL,
	`featureName` text,
	`metadata` text,
	`durationSeconds` integer,
	`contentSnapshot` text,
	`diff` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ae_userId_idx` ON `activity_events` (`userId`);--> statement-breakpoint
CREATE INDEX `ae_eventType_idx` ON `activity_events` (`eventType`);--> statement-breakpoint
CREATE INDEX `ae_featureName_idx` ON `activity_events` (`featureName`);--> statement-breakpoint
CREATE INDEX `ae_createdAt_idx` ON `activity_events` (`createdAt`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`action` text NOT NULL,
	`entityType` text,
	`entityId` integer,
	`metadata` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `al_userId_idx` ON `audit_logs` (`userId`);--> statement-breakpoint
CREATE INDEX `al_action_idx` ON `audit_logs` (`action`);--> statement-breakpoint
CREATE INDEX `al_createdAt_idx` ON `audit_logs` (`createdAt`);--> statement-breakpoint
CREATE TABLE `beta_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`rejectionReason` text,
	`waveName` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `beta_requests_email_unique` ON `beta_requests` (`email`);--> statement-breakpoint
CREATE TABLE `characters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`name` text NOT NULL,
	`age` text,
	`description` text,
	`abilities` text,
	`relationships` text,
	`notes` text,
	`customAttributes` text,
	`sizeBytes` integer DEFAULT 0 NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `email_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipientEmail` text NOT NULL,
	`templateId` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`templateId`) REFERENCES `email_templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `el_recipient_email_idx` ON `email_logs` (`recipientEmail`);--> statement-breakpoint
CREATE INDEX `el_template_id_idx` ON `email_logs` (`templateId`);--> statement-breakpoint
CREATE TABLE `email_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`variables` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_templates_name_unique` ON `email_templates` (`name`);--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer,
	`category` text DEFAULT 'other' NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`rating` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `fb_userId_idx` ON `feedback` (`userId`);--> statement-breakpoint
CREATE INDEX `fb_status_idx` ON `feedback` (`status`);--> statement-breakpoint
CREATE TABLE `main_story_scenes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`sceneId` integer NOT NULL,
	`versionId` integer NOT NULL,
	`order` integer NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sceneId`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`versionId`) REFERENCES `scene_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`senderId` integer,
	`recipientId` integer,
	`subject` text,
	`body` text NOT NULL,
	`type` text DEFAULT 'internal' NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`senderId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recipientId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `msg_recipient_id_idx` ON `messages` (`recipientId`);--> statement-breakpoint
CREATE INDEX `msg_sender_id_idx` ON `messages` (`senderId`);--> statement-breakpoint
CREATE TABLE `project_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`settingKey` text NOT NULL,
	`settingValue` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_settings_project_key_unique` ON `project_settings` (`projectId`,`settingKey`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `request_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requestId` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`status` integer NOT NULL,
	`durationMs` integer NOT NULL,
	`userId` integer,
	`ip` text,
	`userAgent` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `rl_createdAt_idx` ON `request_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `rl_requestId_idx` ON `request_logs` (`requestId`);--> statement-breakpoint
CREATE INDEX `rl_userId_idx` ON `request_logs` (`userId`);--> statement-breakpoint
CREATE INDEX `rl_status_idx` ON `request_logs` (`status`);--> statement-breakpoint
CREATE TABLE `scene_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sceneId` integer NOT NULL,
	`versionLabel` text DEFAULT 'draft' NOT NULL,
	`content` text NOT NULL,
	`sizeBytes` integer DEFAULT 0 NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`sceneId`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`wordCount` integer DEFAULT 0 NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`context` text,
	`requestId` text,
	`method` text,
	`path` text,
	`status` integer,
	`userId` integer,
	`stack` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sl_createdAt_idx` ON `system_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `sl_level_idx` ON `system_logs` (`level`);--> statement-breakpoint
CREATE INDEX `sl_requestId_idx` ON `system_logs` (`requestId`);--> statement-breakpoint
CREATE INDEX `sl_userId_idx` ON `system_logs` (`userId`);--> statement-breakpoint
CREATE TABLE `system_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`startedAt` integer DEFAULT (unixepoch()) NOT NULL,
	`endedAt` integer,
	`durationSeconds` integer,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `us_userId_idx` ON `user_sessions` (`userId`);--> statement-breakpoint
CREATE INDEX `us_startedAt_idx` ON `user_sessions` (`startedAt`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`penName` text,
	`bio` text,
	`theme` text DEFAULT 'light' NOT NULL,
	`defaultExportFormat` text DEFAULT 'pdf' NOT NULL,
	`writingGoalDaily` integer DEFAULT 500,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_storage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`limitBytes` integer DEFAULT 524288000 NOT NULL,
	`usedBytes` integer DEFAULT 0 NOT NULL,
	`lastRecomputedAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `us_storage_userId_idx` ON `user_storage` (`userId`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`openId` text NOT NULL,
	`name` text,
	`email` text,
	`contactEmail` text,
	`loginMethod` text,
	`passwordHash` text,
	`role` text DEFAULT 'user' NOT NULL,
	`betaExpiry` integer,
	`betaTier` text DEFAULT 'none' NOT NULL,
	`forcePasswordChange` integer DEFAULT false NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	`lastSignedIn` integer DEFAULT (unixepoch()) NOT NULL,
	`suspendedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_openId_unique` ON `users` (`openId`);--> statement-breakpoint
CREATE TABLE `world_building_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`sizeBytes` integer DEFAULT 0 NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `writing_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`projectId` integer,
	`startedAt` integer DEFAULT (unixepoch()) NOT NULL,
	`endedAt` integer,
	`durationSeconds` integer,
	`wordCountStart` integer,
	`wordCountEnd` integer,
	`contentSnapshot` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ws_userId_idx` ON `writing_sessions` (`userId`);--> statement-breakpoint
CREATE INDEX `ws_projectId_idx` ON `writing_sessions` (`projectId`);--> statement-breakpoint
CREATE INDEX `ws_startedAt_idx` ON `writing_sessions` (`startedAt`);