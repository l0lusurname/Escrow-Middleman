import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { db } from "../db/index.js";
import { trades, tickets, botConfig } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { formatAmount } from "../utils/currencyParser.js";
import { logAction } from "../utils/auditLog.js";
import { createTradeChannel, createTradeSetupModal, createVerificationEmbed, createVerificationButtons } from "../ui/tradeChannel.js";
import { refreshPublicEmbed } from "../ui/publicEmbed.js";

const BOT_MC_USERNAME = process.env.MINECRAFT_USERNAME || "Bunji_MC";

export async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;

  if (customId === "start_middleman") {
    return handleStartMiddleman(interaction);
  } else if (customId.startsWith("setup_trade_")) {
    return handleSetupTrade(interaction);
  } else if (customId.startsWith("cancel_trade_") && !customId.includes("_db_")) {
    return handleCancelChannel(interaction);
  } else if (customId.startsWith("copy_pay_seller_")) {
    return handleCopyPay(interaction, "seller");
  } else if (customId.startsWith("copy_pay_buyer_")) {
    return handleCopyPay(interaction, "buyer");
  } else if (customId.startsWith("deposit_escrow_")) {
    return handleDepositEscrow(interaction);
  } else if (customId.startsWith("confirm_delivered_")) {
    return handleConfirmDelivered(interaction);
  } else if (customId.startsWith("mark_scammed_")) {
    return handleMarkScammedButton(interaction);
  } else if (customId.startsWith("request_cancel_") || customId.startsWith("cancel_trade_db_")) {
    return handleRequestCancel(interaction);
  } else if (customId.startsWith("adj_seller_")) {
    return handleAdjudicateButton(interaction, "seller");
  } else if (customId.startsWith("adj_buyer_")) {
    return handleAdjudicateButton(interaction, "buyer");
  } else if (customId.startsWith("close_dispute_")) {
    return handleCloseDispute(interaction);
  } else if (customId.startsWith("attach_evidence_")) {
    return handleAttachEvidence(interaction);
  }
}

async function handleStartMiddleman(interaction) {
  try {
    await createTradeChannel(interaction);
  } catch (error) {
    console.error("Start middleman error:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Failed to start trade. Please try again.", ephemeral: true });
    }
  }
}

async function handleSetupTrade(interaction) {
  const shortId = interaction.customId.split("_").slice(2).join("_");
  try {
    const modal = createTradeSetupModal(shortId);
    await interaction.showModal(modal);
  } catch (error) {
    console.error("Setup trade error:", error);
    await interaction.reply({ content: "Failed to open trade setup. Please try again.", ephemeral: true });
  }
}

async function handleCancelChannel(interaction) {
  const shortId = interaction.customId.split("_").slice(2).join("_");
  try {
    await interaction.reply({ content: "Trade cancelled. This channel will be deleted in 10 seconds...", ephemeral: false });
    setTimeout(async () => {
      try {
        await interaction.channel.delete("Trade cancelled by user");
      } catch (e) {
        console.error("Could not delete channel:", e);
      }
    }, 10000);
  } catch (error) {
    console.error("Cancel channel error:", error);
  }
}

async function handleCopyPay(interaction, party) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", ephemeral: true });
    }

    const amount = party === "seller"
      ? parseFloat(trade.verificationAmountSeller)
      : parseFloat(trade.verificationAmountBuyer);

    const payCommand = `/pay ${BOT_MC_USERNAME} ${amount.toFixed(2)}`;

    const embed = new EmbedBuilder()
      .setTitle(`Copy Pay Command - ${party === "seller" ? "Seller" : "Buyer"}`)
      .setColor(0x00AE86)
      .setDescription(
        `**Copy this command and paste it in Minecraft:**\n\n` +
        `\`\`\`\n${payCommand}\n\`\`\`\n\n` +
        `After paying, the bot will automatically detect your payment.`
      )
      .setFooter({ text: `Amount: $${amount.toFixed(2)} • Recipient: ${BOT_MC_USERNAME}` });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    console.error("Copy pay error:", error);
    await interaction.reply({ content: "An error occurred.", ephemeral: true });
  }
}

async function handleDepositEscrow(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", ephemeral: true });
    }

    if (trade.buyerDiscordId !== interaction.user.id) {
      return interaction.reply({ content: "Only the buyer can deposit to escrow.", ephemeral: true });
    }

    if (!trade.buyerVerified || !trade.sellerVerified) {
      return interaction.reply({ content: "Both parties must be verified first.", ephemeral: true });
    }

    const saleAmount = parseFloat(trade.saleAmount);
    const payCommand = `/pay ${BOT_MC_USERNAME} ${saleAmount.toFixed(2)}`;

    const embed = new EmbedBuilder()
      .setTitle("Deposit to Escrow")
      .setColor(0xFFAA00)
      .setDescription(
        `**Deposit the sale amount to escrow:**\n\n` +
        `\`\`\`\n${payCommand}\n\`\`\`\n\n` +
        `The bot will hold this amount until you confirm delivery.\n` +
        `Once you're satisfied with the trade, click "Confirm Delivery".`
      )
      .addFields(
        { name: "Sale Amount", value: formatAmount(saleAmount), inline: true },
        { name: "Recipient", value: BOT_MC_USERNAME, inline: true }
      )
      .setFooter({ text: "Funds are held securely until you confirm delivery" });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    console.error("Deposit escrow error:", error);
    await interaction.reply({ content: "An error occurred.", ephemeral: true });
  }
}

async function handleConfirmDelivered(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", ephemeral: true });
    }

    if (trade.buyerDiscordId !== interaction.user.id) {
      return interaction.reply({ content: "Only the buyer can confirm delivery.", ephemeral: true });
    }

    if (trade.status !== "IN_ESCROW") {
      return interaction.reply({ content: "Trade must be in escrow to confirm delivery.", ephemeral: true });
    }

    if (trade.frozen) {
      return interaction.reply({ content: "Trade is frozen. Contact support.", ephemeral: true });
    }

    await interaction.deferReply();

    const saleAmount = parseFloat(trade.saleAmount);
    const feeAmount = saleAmount * 0.05;
    const sellerReceives = saleAmount - feeAmount;

    await db.update(trades).set({
      status: "COMPLETED",
      feeAmount: feeAmount.toFixed(2),
      escrowBalance: "0.00",
      updatedAt: new Date(),
    }).where(eq(trades.id, tradeId));

    await db.update(tickets).set({
      status: "CLOSED",
      updatedAt: new Date(),
    }).where(eq(tickets.tradeId, tradeId));

    await logAction(tradeId, interaction.user.id, "DELIVERY_CONFIRMED", { feeAmount, sellerReceives });

    const completionEmbed = new EmbedBuilder()
      .setTitle(`Trade #${tradeId} Completed`)
      .setColor(0x00FF00)
      .addFields(
        { name: "Sale Amount", value: formatAmount(saleAmount), inline: true },
        { name: "Fee (5%)", value: formatAmount(feeAmount), inline: true },
        { name: "Seller Received", value: formatAmount(sellerReceives), inline: true },
        { name: "Seller", value: `<@${trade.sellerDiscordId}> (${trade.sellerMc})`, inline: true },
        { name: "Buyer", value: `<@${trade.buyerDiscordId}> (${trade.buyerMc})`, inline: true },
      )
      .setDescription(`Release **${formatAmount(sellerReceives)}** to \`${trade.sellerMc}\` in-game.`)
      .setTimestamp();

    await interaction.editReply({
      content: `Trade #${tradeId} has been completed!`,
      embeds: [completionEmbed],
    });

    const guild = interaction.guild;
    const [config] = await db.select().from(botConfig).where(eq(botConfig.guildId, guild.id)).limit(1);

    if (config?.completionChannelId) {
      try {
        const channel = await guild.channels.fetch(config.completionChannelId);
        if (channel) {
          await channel.send({
            content: `Trade #${tradeId} completed! <@${trade.sellerDiscordId}> <@${trade.buyerDiscordId}>`,
            embeds: [completionEmbed],
          });
        }
      } catch (e) {
        console.error("Could not post to completion channel:", e);
      }
    }

    await refreshPublicEmbed(interaction.client, guild.id);
  } catch (error) {
    console.error("Confirm delivered error:", error);
    if (interaction.deferred) {
      await interaction.editReply({ content: "An error occurred." });
    } else {
      await interaction.reply({ content: "An error occurred.", ephemeral: true });
    }
  }
}

async function handleMarkScammedButton(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", ephemeral: true });
    }

    const userId = interaction.user.id;
    if (trade.sellerDiscordId !== userId && trade.buyerDiscordId !== userId) {
      return interaction.reply({ content: "Only trade participants can report a scam.", ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId(`scam_modal_${tradeId}`)
      .setTitle(`Report Scam - Trade #${tradeId}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("reason")
            .setLabel("Reason for Report")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Describe what happened...")
            .setRequired(true)
            .setMaxLength(1000)
        )
      );

    await interaction.showModal(modal);
  } catch (error) {
    console.error("Mark scammed button error:", error);
    await interaction.reply({ content: "An error occurred.", ephemeral: true });
  }
}

async function handleRequestCancel(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", ephemeral: true });
    }

    const userId = interaction.user.id;
    if (trade.sellerDiscordId !== userId && trade.buyerDiscordId !== userId) {
      return interaction.reply({ content: "Only trade participants can request cancellation.", ephemeral: true });
    }

    await logAction(tradeId, userId, "CANCELLATION_REQUESTED", {});

    await interaction.reply({
      content: `<@${trade.sellerDiscordId}> <@${trade.buyerDiscordId}> - A cancellation has been requested by <@${userId}>. Both parties must agree to cancel. An admin can use \`/mm close_ticket ${tradeId}\` to finalize.`,
    });
  } catch (error) {
    console.error("Request cancel error:", error);
    await interaction.reply({ content: "An error occurred.", ephemeral: true });
  }
}

async function handleAdjudicateButton(interaction, decision) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  if (!interaction.member.permissions.has("Administrator")) {
    return interaction.reply({ content: "Only admins can adjudicate trades.", ephemeral: true });
  }

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", ephemeral: true });
    }

    if (trade.status === "COMPLETED" || trade.status === "CANCELLED") {
      return interaction.reply({ content: `Trade is already ${trade.status.toLowerCase()}.`, ephemeral: true });
    }

    await interaction.deferReply();

    const saleAmount = parseFloat(trade.saleAmount);
    const feeAmount = saleAmount * 0.05;

    let recipientId, recipientMc, amountReleased;

    if (decision === "seller") {
      recipientId = trade.sellerDiscordId;
      recipientMc = trade.sellerMc;
      amountReleased = saleAmount - feeAmount;
    } else {
      recipientId = trade.buyerDiscordId;
      recipientMc = trade.buyerMc;
      amountReleased = saleAmount;
    }

    await db.update(trades).set({
      status: "COMPLETED",
      frozen: false,
      feeAmount: decision === "seller" ? feeAmount.toFixed(2) : "0.00",
      updatedAt: new Date(),
    }).where(eq(trades.id, tradeId));

    await db.update(tickets).set({
      status: "CLOSED",
      updatedAt: new Date(),
    }).where(eq(tickets.tradeId, tradeId));

    await logAction(tradeId, interaction.user.id, "ADJUDICATED_VIA_BUTTON", { decision, amountReleased });

    const embed = new EmbedBuilder()
      .setTitle(`Trade #${tradeId} Adjudicated`)
      .setColor(0x00FF00)
      .addFields(
        { name: "Decision", value: `Funds released to ${decision}`, inline: true },
        { name: "Recipient", value: `<@${recipientId}> (${recipientMc})`, inline: true },
        { name: "Amount Released", value: formatAmount(amountReleased), inline: true },
        { name: "Adjudicator", value: `<@${interaction.user.id}>` },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error("Adjudicate button error:", error);
    if (interaction.deferred) {
      await interaction.editReply({ content: "An error occurred." });
    } else {
      await interaction.reply({ content: "An error occurred.", ephemeral: true });
    }
  }
}

async function handleCloseDispute(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  if (!interaction.member.permissions.has("Administrator")) {
    return interaction.reply({ content: "Only admins can close disputes.", ephemeral: true });
  }

  try {
    await db.update(tickets).set({
      status: "CLOSED",
      updatedAt: new Date(),
    }).where(eq(tickets.tradeId, tradeId));

    await logAction(tradeId, interaction.user.id, "DISPUTE_CLOSED", {});

    await interaction.reply({ content: `Dispute for Trade #${tradeId} has been closed.` });
  } catch (error) {
    console.error("Close dispute error:", error);
    await interaction.reply({ content: "An error occurred.", ephemeral: true });
  }
}

async function handleAttachEvidence(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const modal = new ModalBuilder()
      .setCustomId(`evidence_modal_${tradeId}`)
      .setTitle("Attach Evidence")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("evidence")
            .setLabel("Evidence / Notes")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Paste screenshots links, describe evidence, etc...")
            .setRequired(true)
            .setMaxLength(2000)
        )
      );

    await interaction.showModal(modal);
  } catch (error) {
    console.error("Attach evidence error:", error);
    await interaction.reply({ content: "An error occurred.", ephemeral: true });
  }
}
