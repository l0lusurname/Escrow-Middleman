import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { db } from "../db/index.js";
import { botConfig, trades } from "../db/schema.js";
import { eq, desc, and, or, gte, sql } from "drizzle-orm";

const BOT_MC_USERNAME = process.env.MINECRAFT_USERNAME || "Bunji_MC";
const FEE_PERCENT = parseFloat(process.env.FEE_PERCENT) || 5.0;

export function createPublicEmbed() {
  const embed = new EmbedBuilder()
    .setTitle("Cryptocurrency Middleman System")
    .setColor(0x2F3136)
    .setDescription(
      `Trade safely with our automated middleman service!\n\n` +
      `**How it works:**\n` +
      `1. Click the button below to create a ticket\n` +
      `2. Tag your trading partner in the ticket\n` +
      `3. Select your roles (Sender/Receiver)\n` +
      `4. Sender deposits the payment\n` +
      `5. Receiver delivers the goods\n` +
      `6. Sender releases funds to complete the deal\n\n` +
      `Your funds are protected the entire time.`
    )
    .addFields(
      {
        name: "Service Fee",
        value: `**${FEE_PERCENT}%** of deal\n_(taken from receiver)_`,
        inline: true,
      },
      {
        name: "Pay To",
        value: `\`${BOT_MC_USERNAME}\`\nin Minecraft`,
        inline: true,
      },
      {
        name: "Need Help?",
        value: `Tag staff if you\nhave questions`,
        inline: true,
      }
    )
    .setFooter({ text: "Safe & Secure Middleman" })
    .setTimestamp();

  return embed;
}

export function createStartButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("start_middleman")
      .setLabel("Create Ticket")
      .setStyle(ButtonStyle.Success)
  );
}

export async function postOrUpdatePublicEmbed(client, guildId) {
  try {
    const [config] = await db.select().from(botConfig).where(eq(botConfig.guildId, guildId)).limit(1);

    if (!config?.publicMiddlemanChannelId) {
      console.log("No public middleman channel configured for guild:", guildId);
      return null;
    }

    const guild = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(config.publicMiddlemanChannelId);

    if (!channel) {
      console.error("Could not find public middleman channel");
      return null;
    }

    const embed = createPublicEmbed();
    const button = createStartButton();

    if (config.publicEmbedMessageId) {
      try {
        const existingMessage = await channel.messages.fetch(config.publicEmbedMessageId);
        await existingMessage.edit({ embeds: [embed], components: [button] });
        return existingMessage;
      } catch (e) {
        console.log("Could not find existing embed message, posting new one");
      }
    }

    const message = await channel.send({ embeds: [embed], components: [button] });

    await db.update(botConfig).set({
      publicEmbedMessageId: message.id,
      updatedAt: new Date(),
    }).where(eq(botConfig.guildId, guildId));

    return message;
  } catch (error) {
    console.error("Error posting/updating public embed:", error);
    return null;
  }
}

export async function refreshPublicEmbed(client, guildId) {
  return postOrUpdatePublicEmbed(client, guildId);
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

export function createAdminPanelEmbed(stats) {
  const embed = new EmbedBuilder()
    .setTitle("Admin Panel")
    .setColor(0x5865F2)
    .addFields(
      {
        name: "Today's Profit",
        value: `$${stats.today.fees.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Today's Volume",
        value: `$${stats.today.volume.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Trades Today",
        value: `${stats.today.trades}`,
        inline: true,
      },
      {
        name: "All-Time Profit",
        value: `$${stats.allTime.fees.toFixed(2)}`,
        inline: true,
      },
      {
        name: "All-Time Volume",
        value: `$${stats.allTime.volume.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Total Trades",
        value: `${stats.allTime.trades}`,
        inline: true,
      },
      {
        name: "Active Trades",
        value: `${stats.active}`,
        inline: true,
      },
      {
        name: "Open Disputes",
        value: `${stats.disputes}`,
        inline: true,
      }
    )
    .setFooter({ text: "Last updated" })
    .setTimestamp();

  return embed;
}
