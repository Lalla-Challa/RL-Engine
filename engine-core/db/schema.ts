import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Local-first schema (SQLite / better-sqlite3).
 *
 * Column notes:
 * - `text(..., { enum: [...] })` replaces MySQL ENUM columns.
 * - `text(..., { mode: "json" })` stores JSON as text.
 * - `integer(..., { mode: "timestamp" })` stores unix epoch seconds.
 * - `integer(..., { mode: "boolean" })` stores 0/1.
 */

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Unique local identity (e.g. "local:primary" or an OAuth openId). */
  openId: text("openId").notNull().unique(),
  name: text("name"),
  email: text("email"),
  contactEmail: text("contactEmail"),
  loginMethod: text("loginMethod"),
  passwordHash: text("passwordHash"),
  role: text("role", {
    enum: ["user", "admin", "super_admin", "support", "viewer"],
  })
    .default("user")
    .notNull(),
  betaExpiry: integer("betaExpiry", { mode: "timestamp" }),
  betaTier: text("betaTier", { enum: ["none", "beta", "pro"] })
    .default("none")
    .notNull(),
  forcePasswordChange: integer("forcePasswordChange", { mode: "boolean" })
    .default(false)
    .notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date())
    .notNull(),
  lastSignedIn: integer("lastSignedIn", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
  /** Nullable timestamp set when an admin suspends the account. */
  suspendedAt: integer("suspendedAt", { mode: "timestamp" }),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// Projects table
export const projects = sqliteTable(
  "projects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    /**
     * The CCM Story Spec (CCM spec §1): premise, themes, targets, forbidden
     * outcomes. Shape: `{ premise: string, themes: string[], targets: string[],
     * forbidden: string[] }`. Null until the author fills it in.
     */
    spec: text("spec", { mode: "json" }),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    titleIdx: index("projects_title_idx").on(table.title),
    descriptionIdx: index("projects_description_idx").on(table.description),
  })
);

export type Project = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;

// Project Settings table
export const projectSettings = sqliteTable(
  "project_settings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    settingKey: text("settingKey").notNull(),
    settingValue: text("settingValue", { mode: "json" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    projectKeyUnique: uniqueIndex("project_settings_project_key_unique").on(
      table.projectId,
      table.settingKey
    ),
    projectIdIdx: index("project_settings_projectId_idx").on(table.projectId),
    keyIdx: index("project_settings_key_idx").on(table.settingKey),
  })
);

export type ProjectSetting = typeof projectSettings.$inferSelect;
export type InsertProjectSetting = typeof projectSettings.$inferInsert;

export const scenes = sqliteTable(
  "scenes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", { enum: ["draft", "revised", "final"] })
      .default("draft")
      .notNull(),
    wordCount: integer("wordCount").default(0).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("scenes_projectId_idx").on(table.projectId),
    titleIdx: index("scenes_title_idx").on(table.title),
  })
);

export type Scene = typeof scenes.$inferSelect;
export type InsertScene = typeof scenes.$inferInsert;

// Scene versions table (git-like versioning)
export const sceneVersions = sqliteTable(
  "scene_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sceneId: integer("sceneId")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    versionLabel: text("versionLabel", {
      enum: ["draft", "revised", "final"],
    })
      .default("draft")
      .notNull(),
    content: text("content").notNull(),
    sizeBytes: integer("sizeBytes").default(0).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    sceneIdIdx: index("scene_versions_sceneId_idx").on(table.sceneId),
  })
);

export type InsertSceneVersion = typeof sceneVersions.$inferInsert;

// Main story (merged branch) - tracks which version of each scene is in the final story
export const mainStoryScenes = sqliteTable(
  "main_story_scenes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sceneId: integer("sceneId")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    versionId: integer("versionId")
      .notNull()
      .references(() => sceneVersions.id, { onDelete: "cascade" }),
    order: integer("order").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("main_story_projectId_idx").on(table.projectId),
    orderIdx: index("main_story_order_idx").on(table.order),
  })
);

export type MainStoryScene = typeof mainStoryScenes.$inferSelect;
export type InsertMainStoryScene = typeof mainStoryScenes.$inferInsert;

// User Settings table
export const userSettings = sqliteTable(
  "user_settings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    penName: text("penName"),
    bio: text("bio"),
    theme: text("theme", { enum: ["light", "dark", "sepia"] })
      .default("light")
      .notNull(),
    defaultExportFormat: text("defaultExportFormat", {
      enum: ["md", "docx", "pdf"],
    })
      .default("pdf")
      .notNull(),
    writingGoalDaily: integer("writingGoalDaily").default(500),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    userIdIdx: index("user_settings_userId_idx").on(table.userId),
  })
);

export type UserSetting = typeof userSettings.$inferSelect;
export type InsertUserSetting = typeof userSettings.$inferInsert;

// User Storage table
export const userStorage = sqliteTable(
  "user_storage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    limitBytes: integer("limitBytes").default(524288000).notNull(), // 500 MB default
    usedBytes: integer("usedBytes").default(0).notNull(),
    lastRecomputedAt: integer("lastRecomputedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    userIdIdx: index("us_storage_userId_idx").on(table.userId),
  })
);

export type UserStorage = typeof userStorage.$inferSelect;
export type InsertUserStorage = typeof userStorage.$inferInsert;

// Beta requests table
export const betaRequests = sqliteTable("beta_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  reason: text("reason").notNull(),
  status: text("status", {
    enum: ["pending", "approved", "denied", "invited"],
  })
    .default("pending")
    .notNull(),
  rejectionReason: text("rejectionReason"),
  waveName: text("waveName"),
  createdAt: integer("createdAt", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
});

export type BetaRequest = typeof betaRequests.$inferSelect;
export type InsertBetaRequest = typeof betaRequests.$inferInsert;

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    entityType: text("entityType"),
    entityId: integer("entityId"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => ({
    userIdIdx: index("al_userId_idx").on(table.userId),
    actionIdx: index("al_action_idx").on(table.action),
    createdAtIdx: index("al_createdAt_idx").on(table.createdAt),
  })
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

/**
 * All meaningful user actions that the ActivityTracker records.
 * Stored as text in the database; validated in the application layer.
 */
export type ActivityEventType =
  | "user_signup"
  | "user_login"
  | "user_logout"
  | "project_created"
  | "project_deleted"
  | "project_exported_svp"
  | "project_imported_svp"
  | "scene_created"
  | "scene_deleted"
  | "scene_version_saved"
  | "scene_version_deleted"
  | "actor_created"
  | "actor_deleted"
  | "world_model_created"
  | "world_model_deleted"
  | "world_model_updated"
  | "simulation_run"
  | "simulation_reset"
  | "simulation_snapshot"
  | "simulation_render"
  | "ccm_engine_write"
  | "document_exported"
  | "ai_chat_message_sent"
  | "search_performed"
  | "main_story_scene_added"
  | "main_story_scene_removed"
  | "writing_session_start"
  | "writing_session_heartbeat"
  | "storage_limit_exceeded"
  | "storage_recomputed";

/**
 * Optional JSON metadata stored alongside each activity event.
 * All fields are optional; only applicable fields are populated per event type.
 */
export interface ActivityEventMetadata {
  projectId?: number;
  sceneId?: number;
  characterId?: number;
  noteId?: number;
  /** Mirrors the featureName column for denormalised queries. */
  featureName?: string;
  /** e.g. "pdf", "docx", "md", or search query length as a string. */
  actionDetail?: string;
  /** Initial word count at start of session. */
  wordCountStart?: number;
  /** Cumulative word count delta for heartbeat events. */
  wordCountDelta?: number;
  /** Size in bytes of the data involved in the action. */
  size?: number;
}

/**
 * Records every meaningful user action on the platform.
 * Indexed for efficient filtering and aggregation by the admin analytics queries.
 */
export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventType: text("eventType").notNull(),
    featureName: text("featureName"),
    metadata: text("metadata", { mode: "json" }),
    durationSeconds: integer("durationSeconds"),
    contentSnapshot: text("contentSnapshot"),
    diff: text("diff", { mode: "json" }),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => ({
    userIdIdx: index("ae_userId_idx").on(table.userId),
    eventTypeIdx: index("ae_eventType_idx").on(table.eventType),
    featureNameIdx: index("ae_featureName_idx").on(table.featureName),
    createdAtIdx: index("ae_createdAt_idx").on(table.createdAt),
  })
);

export type ActivityEvent = typeof activityEvents.$inferSelect;
export type InsertActivityEvent = typeof activityEvents.$inferInsert;

/**
 * Tracks discrete writing session boundaries per user/project.
 */
export const writingSessions = sqliteTable(
  "writing_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: integer("projectId").references(() => projects.id, {
      onDelete: "cascade",
    }),
    startedAt: integer("startedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    endedAt: integer("endedAt", { mode: "timestamp" }),
    durationSeconds: integer("durationSeconds"),
    wordCountStart: integer("wordCountStart"),
    wordCountEnd: integer("wordCountEnd"),
    contentSnapshot: text("contentSnapshot"),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => ({
    userIdIdx: index("ws_userId_idx").on(table.userId),
    projectIdIdx: index("ws_projectId_idx").on(table.projectId),
    startedAtIdx: index("ws_startedAt_idx").on(table.startedAt),
  })
);

export type WritingSession = typeof writingSessions.$inferSelect;
export type InsertWritingSession = typeof writingSessions.$inferInsert;

/**
 * Tracks login/logout session boundaries per user.
 * endedAt is null for sessions that are still open or ended via inactivity timeout.
 */
export const userSessions = sqliteTable(
  "user_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: integer("startedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    endedAt: integer("endedAt", { mode: "timestamp" }),
    durationSeconds: integer("durationSeconds"),
  },
  (table) => ({
    userIdIdx: index("us_userId_idx").on(table.userId),
    startedAtIdx: index("us_startedAt_idx").on(table.startedAt),
  })
);

export type UserSession = typeof userSessions.$inferSelect;
export type InsertUserSession = typeof userSessions.$inferInsert;

export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: text("requestId").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    durationMs: integer("durationMs").notNull(),
    userId: integer("userId").references(() => users.id, {
      onDelete: "set null",
    }),
    ip: text("ip"),
    userAgent: text("userAgent"),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => ({
    createdAtIdx: index("rl_createdAt_idx").on(table.createdAt),
    requestIdIdx: index("rl_requestId_idx").on(table.requestId),
    userIdIdx: index("rl_userId_idx").on(table.userId),
    statusIdx: index("rl_status_idx").on(table.status),
  })
);

export type RequestLog = typeof requestLogs.$inferSelect;
export type InsertRequestLog = typeof requestLogs.$inferInsert;

export const systemLogs = sqliteTable(
  "system_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    level: text("level", { enum: ["info", "warn", "error"] }).notNull(),
    message: text("message").notNull(),
    context: text("context", { mode: "json" }),
    requestId: text("requestId"),
    method: text("method"),
    path: text("path"),
    status: integer("status"),
    userId: integer("userId").references(() => users.id, {
      onDelete: "set null",
    }),
    stack: text("stack"),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => ({
    createdAtIdx: index("sl_createdAt_idx").on(table.createdAt),
    levelIdx: index("sl_level_idx").on(table.level),
    requestIdIdx: index("sl_requestId_idx").on(table.requestId),
    userIdIdx: index("sl_userId_idx").on(table.userId),
  })
);

export type SystemLog = typeof systemLogs.$inferSelect;
export type InsertSystemLog = typeof systemLogs.$inferInsert;

// ─── Email System ─────────────────────────────────────────────────────────────

export const emailTemplates = sqliteTable("email_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  variables: text("variables", { mode: "json" }), // Array of expected variable names
  createdAt: integer("createdAt", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date())
    .notNull(),
});

export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type InsertEmailTemplate = typeof emailTemplates.$inferInsert;

export const emailLogs = sqliteTable(
  "email_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recipientEmail: text("recipientEmail").notNull(),
    templateId: integer("templateId").references(() => emailTemplates.id),
    status: text("status", { enum: ["pending", "sent", "failed"] })
      .default("pending")
      .notNull(),
    error: text("error"),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => ({
    recipientEmailIdx: index("el_recipient_email_idx").on(
      table.recipientEmail
    ),
    templateIdIdx: index("el_template_id_idx").on(table.templateId),
  })
);

export type EmailLog = typeof emailLogs.$inferSelect;
export type InsertEmailLog = typeof emailLogs.$inferInsert;

export const feedback = sqliteTable(
  "feedback",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("userId").references(() => users.id, {
      onDelete: "set null",
    }),
    category: text("category", {
      enum: ["bug", "feature", "ux", "pricing", "other"],
    })
      .default("other")
      .notNull(),
    content: text("content").notNull(),
    status: text("status", {
      enum: ["new", "reviewed", "actioned", "dismissed"],
    })
      .default("new")
      .notNull(),
    rating: integer("rating"), // 1-10
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    userIdIdx: index("fb_userId_idx").on(table.userId),
    statusIdx: index("fb_status_idx").on(table.status),
  })
);

export type Feedback = typeof feedback.$inferSelect;
export type InsertFeedback = typeof feedback.$inferInsert;

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    senderId: integer("senderId").references(() => users.id, {
      onDelete: "set null",
    }),
    recipientId: integer("recipientId").references(() => users.id, {
      onDelete: "cascade",
    }),
    subject: text("subject"),
    body: text("body").notNull(),
    type: text("type", { enum: ["email", "internal", "whatsapp", "messenger"] })
      .default("internal")
      .notNull(),
    status: text("status", { enum: ["sent", "read"] }).default("sent").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => ({
    recipientIdIdx: index("msg_recipient_id_idx").on(table.recipientId),
    senderIdIdx: index("msg_sender_id_idx").on(table.senderId),
  })
);

export type Message = typeof messages.$inferSelect;
export type InsertMessage = typeof messages.$inferInsert;

export const systemSettings = sqliteTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date())
    .notNull(),
});

export type SystemSetting = typeof systemSettings.$inferSelect;
export type InsertSystemSetting = typeof systemSettings.$inferInsert;

// ─── Idea Vault ─────────────────────────────────────────────────────────────

/**
 * Unidirectional idea sandbox. An idea MAY point at a scene (linkedSceneId),
 * but scenes never point back — the Writing Studio is completely unaware of
 * the Idea Vault.
 */
export const ideas = sqliteTable(
  "ideas",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    status: text("status", {
      enum: ["raw", "evaluating", "adopted", "discarded"],
    })
      .default("raw")
      .notNull(),
    /** Optional scene this idea concerns. Unidirectional: scenes never reference ideas. */
    linkedSceneId: integer("linkedSceneId").references(() => scenes.id, {
      onDelete: "set null",
    }),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("ideas_projectId_idx").on(table.projectId),
    linkedSceneIdIdx: index("ideas_linkedSceneId_idx").on(table.linkedSceneId),
    statusIdx: index("ideas_status_idx").on(table.status),
  })
);

export type Idea = typeof ideas.$inferSelect;
export type InsertIdea = typeof ideas.$inferInsert;

// ─── AI Agent ────────────────────────────────────────────────────────────────

/**
 * Staged proposals produced by the AI agent (propose_draft / propose_precise_edit).
 * Nothing is written to the manuscript until the user accepts a proposal, at
 * which point a new scene version is created through the normal pipeline.
 */
export const agentProposals = sqliteTable(
  "agent_proposals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sceneId: integer("sceneId")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["draft", "precise_edit"] }).notNull(),
    /** Full new content of the scene (HTML, matching version storage). */
    content: text("content").notNull(),
    /** Snapshot of the scene's latest version content at proposal time. */
    originalContent: text("originalContent").notNull(),
    /** For precise_edit: the exact substring that was matched. */
    findString: text("findString"),
    /** For precise_edit: the replacement string. */
    replaceString: text("replaceString"),
    /** Free-form label the agent gave the proposal (e.g. "Rewrite opening"). */
    summary: text("summary"),
    status: text("status", { enum: ["pending", "accepted", "rejected"] })
      .default("pending")
      .notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("ap_projectId_idx").on(table.projectId),
    sceneIdIdx: index("ap_sceneId_idx").on(table.sceneId),
    statusIdx: index("ap_status_idx").on(table.status),
  })
);

export type AgentProposal = typeof agentProposals.$inferSelect;
export type InsertAgentProposal = typeof agentProposals.$inferInsert;

/**
 * Persistent project memory: verified facts, writing rules, and hypotheses
 * the agent can rely on across chat sessions. Injected into every system
 * prompt under a `<Project Memory>` block.
 */
export const projectMemory = sqliteTable(
  "project_memory",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    category: text("category", { enum: ["rule", "fact", "hypothesis", "project_brief", "core_directive"] })
      .default("fact")
      .notNull(),
    content: text("content").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("pm_projectId_idx").on(table.projectId),
  })
);

export type ProjectMemory = typeof projectMemory.$inferSelect;
export type InsertProjectMemory = typeof projectMemory.$inferInsert;

/**
 * Chat sessions for the agent. Messages are stored as a JSON array in the
 * `messages` column. Branching is supported via parentId + parentMessageId;
 * a branch session pre-fills its messages with the parent's history up to
 * the branch point.
 */
export const chatSessions = sqliteTable(
  "chat_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    parentId: integer("parentId").references((): any => chatSessions.id, {
      onDelete: "set null",
    }),
    /** Index into the parent session's messages array at the branch point. */
    parentMessageId: integer("parentMessageId"),
    title: text("title").default("New chat").notNull(),
    /** 'main' = a regular chat; 'research' = an isolated research thread. */
    type: text("type", { enum: ["main", "research", "ideation"] }).default("main").notNull(),
    /** Lifecycle state for research threads. */
    status: text("status", { enum: ["active", "merged", "discarded"] })
      .default("active")
      .notNull(),
    /** JSON array of { role, content, toolCalls?, createdAt } */
    messages: text("messages", { mode: "json" }).notNull(),
    /**
     * LLM-compressed summary of the EARLIEST messages in this session
     * (indices 0..summarizedUpTo). Kept so a long conversation can stay
     * inside the model's context window: the summary is injected instead of
     * the raw messages it covers. Null when nothing has been compressed yet.
     */
    compressedContext: text("compressedContext", { mode: "json" }),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("cs_projectId_idx").on(table.projectId),
    parentIdIdx: index("cs_parentId_idx").on(table.parentId),
  })
);

export type ChatSession = typeof chatSessions.$inferSelect;
export type InsertChatSession = typeof chatSessions.$inferInsert;

/** A single message inside a chat session's messages JSON array. */
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    summary?: string;
  }>;
  createdAt: string;
};

/**
 * Compressed early-conversation context stored on a chat session.
 * `summarizedUpTo` is the index into `messages` of the last message covered
 * by the summary — messages after it are kept verbatim.
 */
export type CompressedContext = {
  summary: string;
  summarizedUpTo: number;
  createdAt: string;
};

// ─── CCM — Causal Continuity Engine ────────────────────────────────────────

/**
 * World clock: `day` + `minute` since the simulation's epoch. The engine
 * advances this on every tick; all events carry a `timestamp` derived from it
 * (day * 1440 + minute) so ordering and simultaneity are preserved.
 */
export type CcmClock = { day: number; minute: number };

export type CcmSimulationSettings = {
  /** How many world-minutes one tick advances the clock. */
  tickMinutes: number;
  /** Hard cap on events a single run.advance may produce (runaway guard). */
  maxEventsPerRun: number;
  /** Presentation granularity for the timeline (does not affect simulation). */
  granularity: "minute" | "hour" | "day";
};

/** Qualitative causal load: class + magnitude (see CCM spec §15). */
export type CcmCausalLoad = {
  class: "connective" | "load_bearing";
  magnitude: "none" | "low" | "moderate" | "high" | "critical";
};

/**
 * A CCM simulation: a run of the engine against a project's world model.
 * The world model itself (actors, environments, systems, rules, relationships,
 * constraints) is project-scoped; simulations hold run config + generated
 * event history (events, episodes, skeletons, snapshots).
 */
export const ccmSimulations = sqliteTable(
  "ccm_simulations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["idle", "running", "paused", "stopped"] })
      .default("idle")
      .notNull(),
    worldSeed: integer("worldSeed").default(1).notNull(),
    simulationSeed: integer("simulationSeed").default(1).notNull(),
    clock: text("clock", { mode: "json" }).notNull(),
    settings: text("settings", { mode: "json" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("ccm_sim_projectId_idx").on(table.projectId),
  })
);

export type CcmSimulation = typeof ccmSimulations.$inferSelect;
export type InsertCcmSimulation = typeof ccmSimulations.$inferInsert;

/**
 * An Actor is any dynamic entity capable of participating in state change
 * (CCM spec §3). This is the canonical project-scoped character entity — it
 * REPLACES the old `characters` table. `attributes` are stable (age, condition,
 * abilities), `state` changes constantly (location, fatigue, emotions).
 * The legacy character profile fields fold in as:
 *   age / abilities / customAttributes → attributes.age / .abilities / .custom
 *   description / notes → dedicated columns
 */
export const ccmActors = sqliteTable(
  "ccm_actors",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").default("human").notNull(),
    description: text("description"),
    notes: text("notes"),
    attributes: text("attributes", { mode: "json" }).notNull(),
    state: text("state", { mode: "json" }).notNull(),
    goals: text("goals", { mode: "json" }).notNull(),
    drives: text("drives", { mode: "json" }).notNull(),
    beliefs: text("beliefs", { mode: "json" }).notNull(),
    knowledge: text("knowledge", { mode: "json" }).notNull(),
    capabilities: text("capabilities", { mode: "json" }).notNull(),
    constraints: text("constraints", { mode: "json" }).notNull(),
    resources: text("resources", { mode: "json" }).notNull(),
    habits: text("habits", { mode: "json" }).notNull(),
    plans: text("plans", { mode: "json" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("ccm_actor_project_idx").on(table.projectId),
    nameIdx: index("ccm_actor_name_idx").on(table.name),
  })
);

export type CcmActor = typeof ccmActors.$inferSelect;
export type InsertCcmActor = typeof ccmActors.$inferInsert;

/** An Environment: a place with its own state, resources and inhabitants. */
export const ccmEnvironments = sqliteTable(
  "ccm_environments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").default("location").notNull(),
    attributes: text("attributes", { mode: "json" }).notNull(),
    state: text("state", { mode: "json" }).notNull(),
    resources: text("resources", { mode: "json" }).notNull(),
    inhabitants: text("inhabitants", { mode: "json" }).notNull(),
    accessibility: text("accessibility", { mode: "json" }).notNull(),
    activeProcesses: text("activeProcesses", { mode: "json" }).notNull(),
    constraints: text("constraints", { mode: "json" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("ccm_env_project_idx").on(table.projectId),
  })
);

export type CcmEnvironment = typeof ccmEnvironments.$inferSelect;
export type InsertCcmEnvironment = typeof ccmEnvironments.$inferInsert;

/**
 * A System: a world mechanism (Cardiology, Weather, Magic, Economy…). Keeps
 * the engine from hardcoding "real world" assumptions — a fantasy world just
 * defines different systems (CCM spec §9).
 */
export const ccmSystems = sqliteTable(
  "ccm_systems",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").default("system").notNull(),
    rules: text("rules", { mode: "json" }).notNull(),
    constraints: text("constraints", { mode: "json" }).notNull(),
    activeConditions: text("activeConditions", { mode: "json" }).notNull(),
    effects: text("effects", { mode: "json" }).notNull(),
    exceptions: text("exceptions", { mode: "json" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("ccm_system_project_idx").on(table.projectId),
  })
);

export type CcmSystem = typeof ccmSystems.$inferSelect;
export type InsertCcmSystem = typeof ccmSystems.$inferInsert;

/**
 * A Rule: the actual engine. WHEN prerequisites hold, it GENERATES candidate
 * events (possibilities, not inevitabilities) with a probability, priority
 * and cooldown (CCM spec §10). `family` keeps rule families separate so a new
 * MagicSystem never requires rewriting RelationshipSystem.
 */
export const ccmRules = sqliteTable(
  "ccm_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    family: text("family", {
      enum: ["actor", "relationship", "environment", "biology", "physics", "social", "temporal", "narrative"],
    })
      .default("actor")
      .notNull(),
    name: text("name").notNull(),
    when: text("when", { mode: "json" }).notNull(),
    candidateEvents: text("candidateEvents", { mode: "json" }).notNull(),
    effects: text("effects", { mode: "json" }).notNull(),
    priority: integer("priority").default(0).notNull(),
    probability: real("probability").default(1).notNull(),
    cooldown: integer("cooldown").default(0).notNull(),
    scope: text("scope").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("ccm_rule_project_idx").on(table.projectId),
    familyIdx: index("ccm_rule_family_idx").on(table.family),
  })
);

export type CcmRule = typeof ccmRules.$inferSelect;
export type InsertCcmRule = typeof ccmRules.$inferInsert;

/**
 * A Relationship: a first-class object with its own state, modifiable by
 * Events (CCM spec §7). Values are qualitative ("low", "emerging").
 */
export const ccmRelationships = sqliteTable(
  "ccm_relationships",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    actorAId: integer("actorAId")
      .notNull()
      .references(() => ccmActors.id, { onDelete: "cascade" }),
    actorBId: integer("actorBId")
      .notNull()
      .references(() => ccmActors.id, { onDelete: "cascade" }),
    familiarity: text("familiarity").default("none").notNull(),
    trust: text("trust").default("none").notNull(),
    affection: text("affection").default("none").notNull(),
    resentment: text("resentment").default("none").notNull(),
    dependence: text("dependence").default("none").notNull(),
    fear: text("fear").default("none").notNull(),
    obligation: text("obligation").default("none").notNull(),
    respect: text("respect").default("none").notNull(),
    knowledge: text("knowledge").default("none").notNull(),
    expectations: text("expectations", { mode: "json" }).notNull(),
    history: text("history", { mode: "json" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("ccm_rel_project_idx").on(table.projectId),
    actorsIdx: index("ccm_rel_actors_idx").on(table.actorAId, table.actorBId),
  })
);

export type CcmRelationship = typeof ccmRelationships.$inferSelect;
export type InsertCcmRelationship = typeof ccmRelationships.$inferInsert;

/**
 * Narrative Constraints: destinations, not immediate events (CCM spec §20, §37).
 * The planner/extractor uses them to bias exploration; the engine never
 * teleports characters toward them.
 */
export const ccmNarrativeConstraints = sqliteTable(
  "ccm_narrative_constraints",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    class: text("class", {
      enum: ["hard", "soft", "forbidden", "range", "temporal"],
    })
      .default("hard")
      .notNull(),
    target: text("target", { mode: "json" }).notNull(),
    description: text("description"),
    /** World-time deadline in minutes (day * 1440 + minute) — a simulation-time constraint. */
    deadline: integer("deadline"),
    priority: integer("priority").default(1).notNull(),
    satisfied: integer("satisfied", { mode: "boolean" }).default(false).notNull(),
    satisfiedAt: integer("satisfiedAt", { mode: "timestamp" }),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("ccm_nc_project_idx").on(table.projectId),
  })
);

export type CcmNarrativeConstraint = typeof ccmNarrativeConstraints.$inferSelect;
export type InsertCcmNarrativeConstraint = typeof ccmNarrativeConstraints.$inferInsert;

/**
 * The atomic record in the event history (CCM spec §13). Micro-events and
 * events share this table, distinguished by `level`. `causalParents` /
 * `causalChildren` are mirrored in `ccm_event_causes` for SQL-queryable
 * ancestry. `causalLoad` + `narrativeWeight` are the two separate axes.
 */
export const ccmEvents = sqliteTable(
  "ccm_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    simulationId: integer("simulationId")
      .notNull()
      .references(() => ccmSimulations.id, { onDelete: "cascade" }),
    level: text("level", { enum: ["micro", "event"] }).default("event").notNull(),
    eventType: text("eventType").notNull(),
    participants: text("participants", { mode: "json" }).notNull(),
    location: text("location"),
    /** World time (day * 1440 + minute). */
    timestamp: integer("timestamp").notNull(),
    trigger: text("trigger", { mode: "json" }).notNull(),
    preconditions: text("preconditions", { mode: "json" }).notNull(),
    action: text("action", { mode: "json" }).notNull(),
    transition: text("transition", { mode: "json" }).notNull(),
    consequences: text("consequences", { mode: "json" }).notNull(),
    causalLoad: text("causalLoad", { mode: "json" }).notNull(),
    narrativeWeight: text("narrativeWeight", { enum: ["low", "medium", "high"] })
      .default("low")
      .notNull(),
    certainty: real("certainty").default(1).notNull(),
    visibility: text("visibility", { enum: ["private", "observed", "public"] })
      .default("private")
      .notNull(),
    stateChanges: text("stateChanges", { mode: "json" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => ({
    simulationIdIdx: index("ccm_evt_sim_idx").on(table.simulationId),
    timestampIdx: index("ccm_evt_ts_idx").on(table.simulationId, table.timestamp),
    levelIdx: index("ccm_evt_level_idx").on(table.level),
  })
);

export type CcmEvent = typeof ccmEvents.$inferSelect;
export type InsertCcmEvent = typeof ccmEvents.$inferInsert;

/** Causal graph edges (event → parent). Queryable ancestry (CCM spec §26). */
export const ccmEventCauses = sqliteTable(
  "ccm_event_causes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("eventId")
      .notNull()
      .references(() => ccmEvents.id, { onDelete: "cascade" }),
    parentEventId: integer("parentEventId")
      .notNull()
      .references(() => ccmEvents.id, { onDelete: "cascade" }),
  },
  (table) => ({
    eventIdIdx: index("ccm_cause_event_idx").on(table.eventId),
    parentIdx: index("ccm_cause_parent_idx").on(table.parentEventId),
    uniquePair: uniqueIndex("ccm_cause_pair_unique").on(
      table.eventId,
      table.parentEventId
    ),
  })
);

export type CcmEventCause = typeof ccmEventCauses.$inferSelect;
export type InsertCcmEventCause = typeof ccmEventCauses.$inferInsert;

/** Pending world processes — scheduled appointments, deadlines, weather fronts. */
export const ccmEventQueue = sqliteTable(
  "ccm_event_queue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    simulationId: integer("simulationId")
      .notNull()
      .references(() => ccmSimulations.id, { onDelete: "cascade" }),
    scheduledAt: integer("scheduledAt").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status", { enum: ["pending", "processed", "cancelled"] })
      .default("pending")
      .notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => ({
    simulationIdIdx: index("ccm_q_sim_idx").on(table.simulationId),
    scheduledIdx: index("ccm_q_sched_idx").on(table.scheduledAt),
  })
);

export type CcmEventQueueItem = typeof ccmEventQueue.$inferSelect;
export type InsertCcmEventQueueItem = typeof ccmEventQueue.$inferInsert;

/** An Episode: a cluster of events that belong together (CCM spec §14, §29). */
export const ccmEpisodes = sqliteTable(
  "ccm_episodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    simulationId: integer("simulationId")
      .notNull()
      .references(() => ccmSimulations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    theme: text("theme"),
    description: text("description"),
    eventIds: text("eventIds", { mode: "json" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    simulationIdIdx: index("ccm_ep_sim_idx").on(table.simulationId),
  })
);

export type CcmEpisode = typeof ccmEpisodes.$inferSelect;
export type InsertCcmEpisode = typeof ccmEpisodes.$inferInsert;

/**
 * A neutral scene skeleton produced by the Scene Builder (CCM spec §30-31).
 * The LLM later renders prose from this — it never invents the causality.
 * `sceneId` is set when the rendered proposal is accepted into the manuscript.
 */
export const ccmSceneSkeletons = sqliteTable(
  "ccm_scene_skeletons",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    simulationId: integer("simulationId")
      .notNull()
      .references(() => ccmSimulations.id, { onDelete: "cascade" }),
    episodeId: integer("episodeId").references(() => ccmEpisodes.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    purpose: text("purpose"),
    location: text("location"),
    time: text("time", { mode: "json" }).notNull(),
    participants: text("participants", { mode: "json" }).notNull(),
    entryState: text("entryState", { mode: "json" }).notNull(),
    activePressures: text("activePressures", { mode: "json" }).notNull(),
    beats: text("beats", { mode: "json" }).notNull(),
    turningPoint: text("turningPoint", { mode: "json" }).notNull(),
    exitState: text("exitState", { mode: "json" }).notNull(),
    unresolvedThreads: text("unresolvedThreads", { mode: "json" }).notNull(),
    importantInformation: text("importantInformation", { mode: "json" }).notNull(),
    continuityNotes: text("continuityNotes", { mode: "json" }).notNull(),
    rendered: integer("rendered", { mode: "boolean" }).default(false).notNull(),
    sceneId: integer("sceneId").references(() => scenes.id, {
      onDelete: "set null",
    }),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    simulationIdIdx: index("ccm_skel_sim_idx").on(table.simulationId),
    episodeIdIdx: index("ccm_skel_episode_idx").on(table.episodeId),
  })
);

export type CcmSceneSkeleton = typeof ccmSceneSkeletons.$inferSelect;
export type InsertCcmSceneSkeleton = typeof ccmSceneSkeletons.$inferInsert;

/** Serialized world snapshots for reproducibility (CCM spec §45). */
export const ccmSnapshots = sqliteTable(
  "ccm_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    simulationId: integer("simulationId")
      .notNull()
      .references(() => ccmSimulations.id, { onDelete: "cascade" }),
    tick: integer("tick").notNull(),
    clock: text("clock", { mode: "json" }).notNull(),
    world: text("world", { mode: "json" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => ({
    simulationIdIdx: index("ccm_snap_sim_idx").on(table.simulationId),
  })
);

export type CcmSnapshot = typeof ccmSnapshots.$inferSelect;
export type InsertCcmSnapshot = typeof ccmSnapshots.$inferInsert;
