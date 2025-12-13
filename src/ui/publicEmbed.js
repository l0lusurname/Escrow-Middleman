import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { db } from "../db/index.js";
import { botConfig, trades } from "../db/schema.js";
import { eq, desc, and, or } from "drizzle-orm";

const BOT_MC_USERNAME = process.env.MINECRAFT_USERNAME || "Bunji_MC";
const FEE_PERCENT = parseFloat(process.env.FEE_PERCENT) || 5.0;

export function createPublicEmbed(activeTrades = []) {
  const embed = new EmbedBuilder()
    .setTitle("🤝 Middleman / Escrow — Donut SMP")
    .setColor(0x00AE86)
    .setDescription(
      `**Safe trading with verified escrow!**\n\n` +
      `Use our middleman service to securely trade items, accounts, or services. ` +
      `All trades are verified through in-game payments to **${BOT_MC_USERNAME}**.`
    )
    .addFields(
      {
        name: "📋 How It Works",
        value:
          `1️⃣ Click **Start Middleman** below\n` +
          `2️⃣ A private trade channel is created for you\n` +
          `3️⃣ Tag the person you want to trade with\n` +
          `4️⃣ Both parties pay small verification amounts to **${BOT_MC_USERNAME}**\n` +
          `5️⃣ Once verified, buyer deposits the sale amount to escrow\n` +
          `6️⃣ Buyer confirms delivery → seller receives funds (minus ${FEE_PERCENT}% fee)\n` +
          `7️⃣ If something goes wrong, click "Mark as Scammed" for support`,
        inline: false,
      },
      {
        name: "💰 Fees",
        value: `**${FEE_PERCENT}%** of the sale amount (deducted from seller's payout)`,
        inline: true,
      },
      {
        name: "🔒 Verification",
        value: `Pay a random amount ($1.00 - $100.24) to **${BOT_MC_USERNAME}** in-game`,
        inline: true,
      }
    )
    .setFooter({ text: "Donut SMP Middleman Service • Secure Trades" })
    .setTimestamp();

  if (activeTrades.length > 0) {
    const statusLines = activeTrades.slice(0, 5).map((trade) => {
      const statusEmoji = getStatusEmoji(trade.status);
      return `${statusEmoji} Trade #${trade.id} — ${trade.status.replace(/_/g, " ")}`;
    });

    embed.addFields({
      name: "📊 Recent Activity",
      value: statusLines.join("\n") || "No active trades",
      inline: false,
    });
  }

  return embed;
}

function getStatusEmoji(status) {
  switch (status) {
    case "CREATED":
      return "🆕";
    case "AWAITING_VERIFICATION":
      return "⏳";
    case "VERIFIED":
      return "✅";
    case "IN_ESCROW":
      return "💼";
    case "COMPLETED":
      return "🎉";
    case "DISPUTE_OPEN":
      return "⚠️";
    case "CANCELLED":
      return "❌";
    default:
      return "📌";
  }
}

export function createStartButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("start_middleman")
      .setLabel("Start Middleman")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🤝")
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

    const recentTrades = await db
      .select()
      .from(trades)
      .where(
        or(
          eq(trades.status, "CREATED"),
          eq(trades.status, "AWAITING_VERIFICATION"),
          eq(trades.status, "VERIFIED"),
          eq(trades.status, "IN_ESCROW")
        )
      )
      .orderBy(desc(trades.createdAt))
      .limit(5);

    const embed = createPublicEmbed(recentTrades);
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
