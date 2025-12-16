import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { db } from "../db/index.js";
import { botConfig, trades } from "../db/schema.js";
import { eq, and, or, gte, sql } from "drizzle-orm";

export async function getGuildConfig(guildId) {
  const [config] = await db.select().from(botConfig).where(eq(botConfig.guildId, guildId)).limit(1);
  return config;
}

export async function getGuildFeePercent(guildId) {
  const config = await getGuildConfig(guildId);
  return parseFloat(config?.feePercent || "5.00");
}

export async function getDailyStats(guildId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  try {
    const completedToday = await db
      .select({
        count: sql`count(*)`,
        totalVolume: sql`COALESCE(sum(${trades.saleAmount}::numeric), 0)`,
        totalFees: sql`COALESCE(sum(${trades.feeAmount}::numeric), 0)`,
      })
      .from(trades)
      .where(
        and(
          eq(trades.status, "COMPLETED"),
          gte(trades.updatedAt, today)
        )
      );

    const allTimeStats = await db
      .select({
        count: sql`count(*)`,
        totalVolume: sql`COALESCE(sum(${trades.saleAmount}::numeric), 0)`,
        totalFees: sql`COALESCE(sum(${trades.feeAmount}::numeric), 0)`,
      })
      .from(trades)
      .where(eq(trades.status, "COMPLETED"));

    const activeTrades = await db
      .select({ count: sql`count(*)` })
      .from(trades)
      .where(
        or(
          eq(trades.status, "AWAITING_ROLES"),
          eq(trades.status, "ROLES_CONFIRMED"),
          eq(trades.status, "AWAITING_PAYMENT"),
          eq(trades.status, "IN_ESCROW")
        )
      );

    const disputes = await db
      .select({ count: sql`count(*)` })
      .from(trades)
      .where(eq(trades.status, "DISPUTE_OPEN"));

    return {
      today: {
        trades: parseInt(completedToday[0]?.count || 0),
        volume: parseFloat(completedToday[0]?.totalVolume || 0),
        fees: parseFloat(completedToday[0]?.totalFees || 0),
      },
      allTime: {
        trades: parseInt(allTimeStats[0]?.count || 0),
        volume: parseFloat(allTimeStats[0]?.totalVolume || 0),
        fees: parseFloat(allTimeStats[0]?.totalFees || 0),
      },
      active: parseInt(activeTrades[0]?.count || 0),
      disputes: parseInt(disputes[0]?.count || 0),
    };
  } catch (error) {
    console.error("Error getting daily stats:", error);
    return {
      today: { trades: 0, volume: 0, fees: 0 },
      allTime: { trades: 0, volume: 0, fees: 0 },
      active: 0,
      disputes: 0,
    };
  }
}

function formatCurrency(amount) {
  if (amount >= 1000000) {
    return `$${(amount / 1000000).toFixed(2)}M`;
  } else if (amount >= 1000) {
    return `$${(amount / 1000).toFixed(1)}K`;
  }
  return `$${amount.toFixed(2)}`;
}

export function createAdminPanelEmbed(stats, config) {
  const feePercent = parseFloat(config?.feePercent || "5.00");
  const minAmount = parseFloat(config?.minTradeAmount || "0.00");
  const maxAmount = config?.maxTradeAmount ? parseFloat(config.maxTradeAmount) : null;
  
  const disputeStatus = stats.disputes > 0 
    ? `\`${stats.disputes}\` open` 
    : `\`0\` open`;

  const embed = new EmbedBuilder()
    .setTitle("Admin Control Panel")
    .setColor(0xF5A623)
    .setDescription(
      `### Today's Performance\n` +
      `\`\`\`\n` +
      `Earnings:  ${formatCurrency(stats.today.fees).padStart(12)}\n` +
      `Volume:    ${formatCurrency(stats.today.volume).padStart(12)}\n` +
      `Trades:    ${String(stats.today.trades).padStart(12)}\n` +
      `\`\`\``
    )
    .addFields(
      {
        name: "All-Time Stats",
        value: 
          `> **Earnings:** ${formatCurrency(stats.allTime.fees)}\n` +
          `> **Volume:** ${formatCurrency(stats.allTime.volume)}\n` +
          `> **Trades:** ${stats.allTime.trades.toLocaleString()}`,
        inline: true,
      },
      {
        name: "Current Status",
        value: 
          `> **Active:** \`${stats.active}\` trades\n` +
          `> **Disputes:** ${disputeStatus}\n` +
          `> **Bot:** Online`,
        inline: true,
      },
      {
        name: "Current Settings",
        value: 
          `> **Fee:** \`${feePercent}%\`\n` +
          `> **Min Trade:** ${minAmount > 0 ? formatCurrency(minAmount) : 'None'}\n` +
          `> **Max Trade:** ${maxAmount ? formatCurrency(maxAmount) : 'Unlimited'}`,
        inline: false,
      }
    )
    .setFooter({ text: "Donut SMP Middleman | Admin Panel" })
    .setTimestamp();

  return embed;
}

export function createAdminPanelButtons() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("admin_change_fee")
      .setLabel("Change Fee")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("💰"),
    new ButtonBuilder()
      .setCustomId("admin_set_limits")
      .setLabel("Set Trade Limits")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📊"),
    new ButtonBuilder()
      .setCustomId("admin_refresh_stats")
      .setLabel("Refresh Stats")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔄")
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("admin_view_channels")
      .setLabel("View Channels")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📺"),
    new ButtonBuilder()
      .setCustomId("admin_post_embed")
      .setLabel("Post/Refresh Embed")
      .setStyle(ButtonStyle.Success)
      .setEmoji("📢")
  );

  return [row1, row2];
}

export function createChangeFeeModal() {
  return new ModalBuilder()
    .setCustomId("admin_fee_modal")
    .setTitle("Change Service Fee")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("new_fee")
          .setLabel("New Fee Percentage")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g., 5.0 or 2.5")
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(5)
      )
    );
}

export function createSetLimitsModal(config) {
  const minAmount = config?.minTradeAmount || "0";
  const maxAmount = config?.maxTradeAmount || "";
  
  return new ModalBuilder()
    .setCustomId("admin_limits_modal")
    .setTitle("Set Trade Limits")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("min_amount")
          .setLabel("Minimum Trade Amount ($)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g., 100 (leave blank for no minimum)")
          .setRequired(false)
          .setValue(minAmount.toString())
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("max_amount")
          .setLabel("Maximum Trade Amount ($)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g., 10000000 (leave blank for unlimited)")
          .setRequired(false)
          .setValue(maxAmount.toString())
      )
    );
}

export function createChannelConfigEmbed(config, guild) {
  const getChannelMention = (channelId) => {
    if (!channelId) return "`Not Set`";
    return `<#${channelId}>`;
  };

  const getRoleMention = (roleId) => {
    if (!roleId) return "`Not Set`";
    return `<@&${roleId}>`;
  };

  const embed = new EmbedBuilder()
    .setTitle("Channel Configuration")
    .setColor(0x5865F2)
    .setDescription("Current channel and role settings for this server.")
    .addFields(
      { name: "Middleman Channel", value: getChannelMention(config?.publicMiddlemanChannelId), inline: true },
      { name: "Completion Channel", value: getChannelMention(config?.completionChannelId), inline: true },
      { name: "Vouch Channel", value: getChannelMention(config?.vouchChannelId), inline: true },
      { name: "Staff Channel", value: getChannelMention(config?.staffChannelId), inline: true },
      { name: "Support Role", value: getRoleMention(config?.supportRoleId), inline: true },
      { name: "\u200B", value: "\u200B", inline: true }
    )
    .setFooter({ text: "Use /mm commands to update these settings" });

  return embed;
}

export function createCloseTicketPromptEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("Trade Complete!")
    .setDescription(
      `Your trade has been completed successfully!\n\n` +
      `If you're done here, you can close this ticket.\n` +
      `The channel will be deleted after closing.`
    )
    .setFooter({ text: "Thank you for using Donut SMP Middleman!" });

  return embed;
}

export function createCloseTicketButton(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`close_completed_ticket_${tradeId}`)
      .setLabel("Close Ticket")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🔒")
  );
}
