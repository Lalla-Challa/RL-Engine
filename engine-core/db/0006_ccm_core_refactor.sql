ALTER TABLE `projects` ADD COLUMN `spec` text;--> statement-breakpoint
CREATE TABLE `ccm_actors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'human' NOT NULL,
	`description` text,
	`notes` text,
	`attributes` text NOT NULL,
	`state` text NOT NULL,
	`goals` text NOT NULL,
	`drives` text NOT NULL,
	`beliefs` text NOT NULL,
	`knowledge` text NOT NULL,
	`capabilities` text NOT NULL,
	`constraints` text NOT NULL,
	`resources` text NOT NULL,
	`habits` text NOT NULL,
	`plans` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `ccm_actor_project_idx` ON `ccm_actors` (`projectId`);--> statement-breakpoint
CREATE INDEX `ccm_actor_name_idx` ON `ccm_actors` (`name`);--> statement-breakpoint
CREATE TABLE `ccm_environments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'location' NOT NULL,
	`attributes` text NOT NULL,
	`state` text NOT NULL,
	`resources` text NOT NULL,
	`inhabitants` text NOT NULL,
	`accessibility` text NOT NULL,
	`activeProcesses` text NOT NULL,
	`constraints` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `ccm_env_project_idx` ON `ccm_environments` (`projectId`);--> statement-breakpoint
CREATE TABLE `ccm_systems` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'system' NOT NULL,
	`rules` text NOT NULL,
	`constraints` text NOT NULL,
	`activeConditions` text NOT NULL,
	`effects` text NOT NULL,
	`exceptions` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `ccm_system_project_idx` ON `ccm_systems` (`projectId`);--> statement-breakpoint
CREATE TABLE `ccm_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`family` text DEFAULT 'actor' NOT NULL,
	`name` text NOT NULL,
	`when` text NOT NULL,
	`candidateEvents` text NOT NULL,
	`effects` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`probability` real DEFAULT 1 NOT NULL,
	`cooldown` integer DEFAULT 0 NOT NULL,
	`scope` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `ccm_rule_project_idx` ON `ccm_rules` (`projectId`);--> statement-breakpoint
CREATE INDEX `ccm_rule_family_idx` ON `ccm_rules` (`family`);--> statement-breakpoint
CREATE TABLE `ccm_relationships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`actorAId` integer NOT NULL,
	`actorBId` integer NOT NULL,
	`familiarity` text DEFAULT 'none' NOT NULL,
	`trust` text DEFAULT 'none' NOT NULL,
	`affection` text DEFAULT 'none' NOT NULL,
	`resentment` text DEFAULT 'none' NOT NULL,
	`dependence` text DEFAULT 'none' NOT NULL,
	`fear` text DEFAULT 'none' NOT NULL,
	`obligation` text DEFAULT 'none' NOT NULL,
	`respect` text DEFAULT 'none' NOT NULL,
	`knowledge` text DEFAULT 'none' NOT NULL,
	`expectations` text NOT NULL,
	`history` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actorAId`) REFERENCES `ccm_actors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actorBId`) REFERENCES `ccm_actors`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `ccm_rel_project_idx` ON `ccm_relationships` (`projectId`);--> statement-breakpoint
CREATE INDEX `ccm_rel_actors_idx` ON `ccm_relationships` (`actorAId`, `actorBId`);--> statement-breakpoint
CREATE TABLE `ccm_narrative_constraints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`name` text NOT NULL,
	`class` text DEFAULT 'hard' NOT NULL,
	`target` text NOT NULL,
	`description` text,
	`deadline` integer,
	`priority` integer DEFAULT 1 NOT NULL,
	`satisfied` integer DEFAULT false NOT NULL,
	`satisfiedAt` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `ccm_nc_project_idx` ON `ccm_narrative_constraints` (`projectId`);--> statement-breakpoint
CREATE TABLE `ccm_simulations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`worldSeed` integer DEFAULT 1 NOT NULL,
	`simulationSeed` integer DEFAULT 1 NOT NULL,
	`clock` text NOT NULL,
	`settings` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `ccm_sim_projectId_idx` ON `ccm_simulations` (`projectId`);--> statement-breakpoint
CREATE TABLE `ccm_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`simulationId` integer NOT NULL,
	`level` text DEFAULT 'event' NOT NULL,
	`eventType` text NOT NULL,
	`participants` text NOT NULL,
	`location` text,
	`timestamp` integer NOT NULL,
	`trigger` text NOT NULL,
	`preconditions` text NOT NULL,
	`action` text NOT NULL,
	`transition` text NOT NULL,
	`consequences` text NOT NULL,
	`causalLoad` text NOT NULL,
	`narrativeWeight` text DEFAULT 'low' NOT NULL,
	`certainty` real DEFAULT 1 NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`stateChanges` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`simulationId`) REFERENCES `ccm_simulations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `ccm_evt_sim_idx` ON `ccm_events` (`simulationId`);--> statement-breakpoint
CREATE INDEX `ccm_evt_ts_idx` ON `ccm_events` (`simulationId`, `timestamp`);--> statement-breakpoint
CREATE INDEX `ccm_evt_level_idx` ON `ccm_events` (`level`);--> statement-breakpoint
CREATE TABLE `ccm_event_causes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`eventId` integer NOT NULL,
	`parentEventId` integer NOT NULL,
	FOREIGN KEY (`eventId`) REFERENCES `ccm_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parentEventId`) REFERENCES `ccm_events`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `ccm_cause_event_idx` ON `ccm_event_causes` (`eventId`);--> statement-breakpoint
CREATE INDEX `ccm_cause_parent_idx` ON `ccm_event_causes` (`parentEventId`);--> statement-breakpoint
CREATE UNIQUE INDEX `ccm_cause_pair_unique` ON `ccm_event_causes` (`eventId`, `parentEventId`);--> statement-breakpoint
CREATE TABLE `ccm_event_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`simulationId` integer NOT NULL,
	`scheduledAt` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`simulationId`) REFERENCES `ccm_simulations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `ccm_q_sim_idx` ON `ccm_event_queue` (`simulationId`);--> statement-breakpoint
CREATE INDEX `ccm_q_sched_idx` ON `ccm_event_queue` (`scheduledAt`);--> statement-breakpoint
CREATE TABLE `ccm_episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`simulationId` integer NOT NULL,
	`title` text NOT NULL,
	`theme` text,
	`description` text,
	`eventIds` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`simulationId`) REFERENCES `ccm_simulations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `ccm_ep_sim_idx` ON `ccm_episodes` (`simulationId`);--> statement-breakpoint
CREATE TABLE `ccm_scene_skeletons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`simulationId` integer NOT NULL,
	`episodeId` integer,
	`title` text NOT NULL,
	`purpose` text,
	`location` text,
	`time` text NOT NULL,
	`participants` text NOT NULL,
	`entryState` text NOT NULL,
	`activePressures` text NOT NULL,
	`beats` text NOT NULL,
	`turningPoint` text NOT NULL,
	`exitState` text NOT NULL,
	`unresolvedThreads` text NOT NULL,
	`importantInformation` text NOT NULL,
	`continuityNotes` text NOT NULL,
	`rendered` integer DEFAULT false NOT NULL,
	`sceneId` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`simulationId`) REFERENCES `ccm_simulations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`episodeId`) REFERENCES `ccm_episodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sceneId`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE INDEX `ccm_skel_sim_idx` ON `ccm_scene_skeletons` (`simulationId`);--> statement-breakpoint
CREATE INDEX `ccm_skel_episode_idx` ON `ccm_scene_skeletons` (`episodeId`);--> statement-breakpoint
CREATE TABLE `ccm_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`simulationId` integer NOT NULL,
	`tick` integer NOT NULL,
	`clock` text NOT NULL,
	`world` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`simulationId`) REFERENCES `ccm_simulations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `ccm_snap_sim_idx` ON `ccm_snapshots` (`simulationId`);
-- Legacy `characters` and `world_building_notes` tables are NOT dropped here:
-- their data is migrated by the runtime migrateLegacyEntities step at vault
-- unlock, which drops them afterwards (see server/modules/actors/legacy.ts).