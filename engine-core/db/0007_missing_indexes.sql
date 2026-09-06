-- 0007: Add missing indexes declared in schema table() callbacks but
-- never generated into any migration (0000–0006).
-- ccm_rules.scope is already plain text in 0006; no change needed here.

CREATE INDEX `projects_title_idx` ON `projects` (`title`);--> statement-breakpoint
CREATE INDEX `projects_description_idx` ON `projects` (`description`);--> statement-breakpoint
CREATE INDEX `project_settings_projectId_idx` ON `project_settings` (`projectId`);--> statement-breakpoint
CREATE INDEX `project_settings_key_idx` ON `project_settings` (`settingKey`);--> statement-breakpoint
CREATE INDEX `scenes_projectId_idx` ON `scenes` (`projectId`);--> statement-breakpoint
CREATE INDEX `scenes_title_idx` ON `scenes` (`title`);--> statement-breakpoint
CREATE INDEX `scene_versions_sceneId_idx` ON `scene_versions` (`sceneId`);--> statement-breakpoint
CREATE INDEX `main_story_projectId_idx` ON `main_story_scenes` (`projectId`);--> statement-breakpoint
CREATE INDEX `main_story_order_idx` ON `main_story_scenes` (`order`);--> statement-breakpoint
CREATE INDEX `user_settings_userId_idx` ON `user_settings` (`userId`);