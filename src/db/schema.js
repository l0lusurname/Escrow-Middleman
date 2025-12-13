import { pgTable, serial, text, decimal, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const linkedAccounts = pgTable("linked_accounts", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull().unique(),
  minecraftUsername: text("minecraft_username").notNull(),
  verificationCode: text("verification_code"),
  verified: boolean("verified").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  sellerDiscordId: text("seller_discord_id").notNull(),
  buyerDiscordId: text("buyer_discord_id").notNull(),
  sellerMc: text("seller_mc").notNull(),
  buyerMc: text("buyer_mc").notNull(),
  saleAmount: decimal("sale_amount", { precision: 20, scale: 2 }).notNull(),
  feePercent: decimal("fee_percent", { precision: 5, scale: 2 }).default("5.00"),
  feeAmount: decimal("fee_amount", { precision: 20, scale: 2 }),
  status: text("status").default("CREATED").notNull(),
  verificationAmountBuyer: decimal("verification_amount_buyer", { precision: 10, scale: 2 }).notNull(),
  verificationAmountSeller: decimal("verification_amount_seller", { precision: 10, scale: 2 }).notNull(),
  buyerVerified: boolean("buyer_verified").default(false),
  sellerVerified: boolean("seller_verified").default(false),
  escrowBalance: decimal("escrow_balance", { precision: 20, scale: 2 }).default("0.00"),
  frozen: boolean("frozen").default(false),
  threadId: text("thread_id"),
  staffThreadId: text("staff_thread_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id").notNull().references(() => trades.id),
  payerMc: text("payer_mc").notNull(),
  recipientMc: text("recipient_mc").notNull(),
  expectedAmount: decimal("expected_amount", { precision: 10, scale: 2 }).notNull(),
  receivedAmount: decimal("received_amount", { precision: 10, scale: 2 }),
  rawLine: text("raw_line"),
  verified: boolean("verified").default(false),
  timestamp: timestamp("timestamp").defaultNow(),
});

export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id").notNull().references(() => trades.id),
  threadId: text("thread_id"),
  channelId: text("channel_id"),
  status: text("status").default("OPEN"),
  supportRoleTagged: boolean("support_role_tagged").default(false),
  staffThreadId: text("staff_thread_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id").references(() => trades.id),
  actorId: text("actor_id").notNull(),
  actorType: text("actor_type").default("user"),
  action: text("action").notNull(),
  rawPayload: jsonb("raw_payload"),
  timestamp: timestamp("timestamp").defaultNow(),
});

export const botConfig = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  completionChannelId: text("completion_channel_id"),
  supportRoleId: text("support_role_id"),
  staffChannelId: text("staff_channel_id"),
  verificationTimeoutMinutes: integer("verification_timeout_minutes").default(10),
  webhookSecret: text("webhook_secret"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const tradesRelations = relations(trades, ({ many }) => ({
  verifications: many(verifications),
  tickets: many(tickets),
  auditLogs: many(auditLogs),
}));

export const verificationsRelations = relations(verifications, ({ one }) => ({
  trade: one(trades, {
    fields: [verifications.tradeId],
    references: [trades.id],
  }),
}));

export const ticketsRelations = relations(tickets, ({ one }) => ({
  trade: one(trades, {
    fields: [tickets.tradeId],
    references: [trades.id],
  }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  trade: one(trades, {
    fields: [auditLogs.tradeId],
    references: [trades.id],
  }),
}));
