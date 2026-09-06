CREATE TABLE `ideas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'raw' NOT NULL,
	`linkedSceneId` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`linkedSceneId`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ideas_projectId_idx` ON `ideas` (`projectId`);--> statement-breakpoint
CREATE INDEX `ideas_linkedSceneId_idx` ON `ideas` (`linkedSceneId`);--> statement-breakpoint
CREATE INDEX `ideas_status_idx` ON `ideas` (`status`);