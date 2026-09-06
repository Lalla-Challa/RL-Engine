CREATE TABLE `agent_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`sceneId` integer NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`originalContent` text NOT NULL,
	`findString` text,
	`replaceString` text,
	`summary` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sceneId`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ap_projectId_idx` ON `agent_proposals` (`projectId`);--> statement-breakpoint
CREATE INDEX `ap_sceneId_idx` ON `agent_proposals` (`sceneId`);--> statement-breakpoint
CREATE INDEX `ap_status_idx` ON `agent_proposals` (`status`);