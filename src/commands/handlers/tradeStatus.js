import { EmbedBuilder } from "discord.js";
import { db } from "../../db/index.js";
import { trades, verifications } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { formatAmount } from "../../utils/currencyParser.js";

export async function handleStatus(interaction) {
  const tradeId = interaction.options.getInteger("trade_id");

  try {
    await interaction.deferReply({ ephemeral: true });

    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.editReply({
        content: `Trade #${tradeId} not found.`,
      });
    }

    const userId = interaction.user.id;
    const isParticipant = trade.sellerDiscordId === userId || trade.buyerDiscordId === userId;
    const isAdmin = interaction.member.permissions.has("Administrator");

    if (!isParticipant && !isAdmin) {
      return interaction.editReply({
        content: "You don't have permission to view this trade.",
      });
    }

    const tradeVerifications = await db.select().from(verifications).where(eq(verifications.tradeId, tradeId));

    const statusColors = {
      CREATED: 0xFFAA00,
      VERIFIED: 0x00AA00,
      IN_ESCROW: 0x0099FF,
      COMPLETED: 0x00FF00,
      DISPUTE_OPEN: 0xFF0000,
      CANCELLED: 0x888888,
      FROZEN: 0x9900FF,
    };

    const embed = new EmbedBuilder()
      .setTitle(`Trade #${tradeId} Status`)
      .setColor(statusColors[trade.status] || 0x888888)
      .addFields(
        { name: "Status", value: trade.frozen ? `${trade.status} (FROZEN)` : trade.status, inline: true },
        { name: "Seller", value: `<@${trade.sellerDiscordId}> (${trade.sellerMc})`, inline: true },
        { name: "Buyer", value: `<@${trade.buyerDiscordId}> (${trade.buyerMc})`, inline: true },
        { name: "Sale Amount", value: formatAmount(trade.saleAmount), inline: true },
        { name: "Fee (5%)", value: formatAmount(trade.feeAmount || (parseFloat(trade.saleAmount) * 0.05)), inline: true },
        { name: "Escrow Balance", value: formatAmount(trade.escrowBalance || 0), inline: true },
        { name: "Buyer Verified", value: trade.buyerVerified ? "Yes" : "No", inline: true },
        { name: "Seller Verified", value: trade.sellerVerified ? "Yes" : "No", inline: true },
        { name: "Created", value: `<t:${Math.floor(new Date(trade.createdAt).getTime() / 1000)}:R>`, inline: true },
      )
      .setTimestamp();

    if (tradeVerifications.length > 0) {
      const verificationInfo = tradeVerifications
        .map((v) => `${v.payerMc} → ${v.recipientMc}: ${formatAmount(v.receivedAmount || v.expectedAmount)} ${v.verified ? "✓" : "pending"}`)
        .join("\n");
      embed.addFields({ name: "Verifications", value: verificationInfo || "None" });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error("Status error:", error);
    await interaction.editReply({
      content: "An error occurred while fetching trade status.",
    });
  }
}
