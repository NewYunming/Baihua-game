import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(), passwordSalt: text("password_salt").notNull(),
  createdAt: integer("created_at").notNull(), lastSeen: integer("last_seen").notNull(),
}, t => [uniqueIndex("idx_users_username").on(t.username)]);
export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(), userId: text("user_id").notNull().references(() => users.id),
  expiresAt: integer("expires_at").notNull(),
});
export const loginAttempts = sqliteTable("login_attempts", {
  key: text("key").primaryKey(), failures: integer("failures").notNull(), windowStart: integer("window_start").notNull(),
});
export const scores = sqliteTable("scores", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id),
  mode: text("mode").notNull(), wave: integer("wave").notNull(), kills: integer("kills").notNull(),
  durationMs: integer("duration_ms").notNull(), weapon: text("weapon").notNull(),
  screenshotKey: text("screenshot_key"), source: text("source").notNull(), createdAt: integer("created_at").notNull(),
}, t => [index("idx_scores_user_time").on(t.userId, t.createdAt)]);
export const friendships = sqliteTable("friendships", {
  id: text("id").primaryKey(), requesterId: text("requester_id").notNull().references(() => users.id),
  recipientId: text("recipient_id").notNull().references(() => users.id),
  status: text("status").notNull(), createdAt: integer("created_at").notNull(),
}, t => [uniqueIndex("idx_friend_pair").on(t.requesterId, t.recipientId), index("idx_friend_recipient").on(t.recipientId, t.status)]);
export const matches = sqliteTable("matches", {
  id: text("id").primaryKey(), player1Id: text("player1_id").notNull().references(() => users.id),
  player2Id: text("player2_id").notNull().references(() => users.id),
  status: text("status").notNull(), state: text("state").notNull(),
  version: integer("version").notNull().default(0), updatedAt: integer("updated_at").notNull(),
}, t => [index("idx_matches_p1").on(t.player1Id, t.updatedAt), index("idx_matches_p2").on(t.player2Id, t.updatedAt)]);
