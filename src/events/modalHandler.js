import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { db } from "../db/index.js";
import { trades, tickets, verifications, botConfig } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { formatAmount } from "../utils/currencyParser.js";
import { logAction } from "../utils/auditLog.js";

export async function handleModalSubmit(interaction) {
  const customId = interaction.customId;

  if (customId.startsWith("scam_modal_")) {
    return handleScamModal(interaction);
  }
}

async function handleScamModal(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());
  const reason = interaction.fields.getTextInputValue("reason");

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", ephemeral: true });
    }

    const userId = interaction.user.id;

    if (trade.status === "COMPLETED" || trade.status === "CANCELLED") {
      return interaction.reply({ 
        content: `This trade is already ${trade.status.toLowerCase()} and cannot be disputed.`, 
        ephemeral: true 
      });
    }

    await interaction.deferReply();

    await db.update(trades).set({ 
      status: "DISPUTE_OPEN",
      frozen: true,
      updatedAt: new Date() 
    }).where(eq(trades.id, tradeId));

    const guild = interaction.guild;
    const [config] = await db.select().from(botConfig).where(eq(botConfig.guildId, guild.id)).limit(1);

    const tradeVerifications = await db.select().from(verifications).where(eq(verifications.tradeId, tradeId));

    const evidenceLines = tradeVerifications
      .map((v) => `\`${v.rawLine || "No raw data"}\` - ${v.timestamp}`)
      .join("\n") || "No verification evidence recorded";

    const reportEmbed = new EmbedBuilder()
      .setTitle(`SCAM REPORT - Trade #${tradeId}`)
      .setColor(0xFF0000)
      .addFields(
        { name: "Reported By", value: `<@${userId}>`, inline: true },
        { name: "Trade Status", value: "DISPUTE_OPEN (Frozen)", inline: true },
        { name: "Sale Amount", value: formatAmount(trade.saleAmount), inline: true },
        { name: "Seller", value: `<@${trade.sellerDiscordId}> (${trade.sellerMc})`, inline: true },
        { name: "Buyer", value: `<@${trade.buyerDiscordId}> (${trade.buyerMc})`, inline: true },
        { name: "Escrow Balance", value: formatAmount(trade.escrowBalance || 0), inline: true },
        { name: "Reason", value: reason },
        { name: "Evidence (Raw Chat Lines)", value: evidenceLines.substring(0, 1000) },
      )
      .setTimestamp();

    const staffButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`freeze_${tradeId}`)
        .setLabel("Freeze Funds")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`adj_seller_${tradeId}`)
        .setLabel("Give to Seller")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`adj_buyer_${tradeId}`)
        .setLabel("Give to Buyer")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`close_dispute_${tradeId}`)
        .setLabel("Close Ticket")
        .setStyle(ButtonStyle.Danger),
    );

    let supportMention = "";
    if (config?.supportRoleId) {
      supportMention = `<@&${config.supportRoleId}> `;
      await db.update(tickets).set({ 
        supportRoleTagged: true, 
        updatedAt: new Date() 
      }).where(eq(tickets.tradeId, tradeId));
    }

    const pinnedMsg = await interaction.channel.send({
      content: `${supportMention}**SCAM REPORTED**`,
      embeds: [reportEmbed],
      components: [staffButtons],
    });

    try {
      await pinnedMsg.pin();
    } catch (e) {
      console.error("Could not pin message:", e);
    }

    if (config?.staffChannelId) {
      try {
        const staffChannel = await guild.channels.fetch(config.staffChannelId);
        if (staffChannel) {
          await staffChannel.send({
            content: `${supportMention}New scam report for Trade #${tradeId}`,
            embeds: [reportEmbed],
            components: [staffButtons],
          });
        }
      } catch (e) {
        console.error("Could not post to staff channel:", e);
      }
    }

    await logAction(tradeId, userId, "MARK_SCAMMED", { reason, previousStatus: trade.status });

    await interaction.editReply({
      content: `Trade #${tradeId} has been reported as a scam. The trade is now frozen and support has been notified.`,
    });
  } catch (error) {
    console.error("Scam modal error:", error);
    if (interaction.deferred) {
      await interaction.editReply({ content: "An error occurred while reporting the scam." });
    } else {
      await interaction.reply({ content: "An error occurred.", ephemeral: true });
    }
  }
}
