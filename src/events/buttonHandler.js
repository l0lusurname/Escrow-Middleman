import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from "discord.js";
import { db } from "../db/index.js";
import { trades, tickets, botConfig } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { formatAmount } from "../utils/currencyParser.js";
import { logAction } from "../utils/auditLog.js";
import { 
  createTradeChannel, 
  createTradeSetupModal, 
  createVerificationEmbed, 
  createVerificationButtons,
  createEscrowEmbed,
  createEscrowButtons,
  createCompletedEmbed,
  createDisputeEmbed,
  createDisputeButtons,
  deleteLastBotMessage
} from "../ui/tradeChannel.js";
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
      await interaction.reply({ content: "Failed to start trade. Please try again.", flags: MessageFlags.Ephemeral });
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
    await interaction.reply({ content: "Failed to open trade setup. Please try again.", flags: MessageFlags.Ephemeral });
  }
}

async function handleCancelChannel(interaction) {
  try {
    await interaction.reply({ content: "Trade cancelled. Channel closing in 10 seconds..." });
    setTimeout(async () => {
      try {
        await interaction.channel.delete("Trade cancelled");
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.editReply({ content: "Trade not found." });
    }

    const amount = party === "seller"
      ? parseFloat(trade.verificationAmountSeller)
      : parseFloat(trade.verificationAmountBuyer);

    const payCommand = `/pay ${BOT_MC_USERNAME} ${amount.toFixed(2)}`;

    await interaction.editReply({ 
      content: `Copy this command:\n\`\`\`${payCommand}\`\`\`` 
    });
  } catch (error) {
    console.error("Copy pay error:", error);
    await interaction.editReply({ content: "An error occurred." });
  }
}

async function handleDepositEscrow(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.editReply({ content: "Trade not found." });
    }

    if (trade.buyerDiscordId !== interaction.user.id) {
      return interaction.editReply({ content: "Only the buyer can deposit to escrow." });
    }

    if (!trade.buyerVerified || !trade.sellerVerified) {
      return interaction.editReply({ content: "Both parties must be verified first." });
    }

    const saleAmount = parseFloat(trade.saleAmount);
    const payCommand = `/pay ${BOT_MC_USERNAME} ${saleAmount.toFixed(2)}`;

    await interaction.editReply({ 
      content: `Deposit to escrow:\n\`\`\`${payCommand}\`\`\`\nThe bot will detect your payment automatically.` 
    });
  } catch (error) {
    console.error("Deposit escrow error:", error);
    await interaction.editReply({ content: "An error occurred." });
  }
}

async function handleConfirmDelivered(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    if (trade.buyerDiscordId !== interaction.user.id) {
      return interaction.reply({ content: "Only the buyer can confirm delivery.", flags: MessageFlags.Ephemeral });
    }

    if (trade.status !== "IN_ESCROW") {
      return interaction.reply({ content: "Trade must be in escrow to confirm delivery.", flags: MessageFlags.Ephemeral });
    }

    if (trade.frozen) {
      return interaction.reply({ content: "Trade is frozen. Contact support.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

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

    try {
      await interaction.message.delete();
    } catch (e) {}

    const completedEmbed = createCompletedEmbed(trade, feeAmount, sellerReceives);

    await interaction.channel.send({
      content: `<@${trade.sellerDiscordId}> <@${trade.buyerDiscordId}>`,
      embeds: [completedEmbed],
    });

    const guild = interaction.guild;
    const [config] = await db.select().from(botConfig).where(eq(botConfig.guildId, guild.id)).limit(1);

    if (config?.completionChannelId) {
      try {
        const channel = await guild.channels.fetch(config.completionChannelId);
        if (channel) {
          await channel.send({ embeds: [completedEmbed] });
        }
      } catch (e) {
        console.error("Could not post to completion channel:", e);
      }
    }

    await refreshPublicEmbed(interaction.client, guild.id);
  } catch (error) {
    console.error("Confirm delivered error:", error);
    if (!interaction.replied) {
      await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
    }
  }
}

async function handleMarkScammedButton(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    const userId = interaction.user.id;
    if (trade.sellerDiscordId !== userId && trade.buyerDiscordId !== userId) {
      return interaction.reply({ content: "Only trade participants can report an issue.", flags: MessageFlags.Ephemeral });
    }

    const modal = new ModalBuilder()
      .setCustomId(`scam_modal_${tradeId}`)
      .setTitle("Report Issue")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("reason")
            .setLabel("What went wrong?")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Describe the issue...")
            .setRequired(true)
            .setMaxLength(1000)
        )
      );

    await interaction.showModal(modal);
  } catch (error) {
    console.error("Mark scammed button error:", error);
    await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
  }
}

async function handleRequestCancel(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    const userId = interaction.user.id;
    if (trade.sellerDiscordId !== userId && trade.buyerDiscordId !== userId) {
      return interaction.reply({ content: "Only trade participants can cancel.", flags: MessageFlags.Ephemeral });
    }

    await logAction(tradeId, userId, "CANCELLATION_REQUESTED", {});

    await interaction.reply({
      content: `<@${trade.sellerDiscordId}> <@${trade.buyerDiscordId}> - Cancellation requested by <@${userId}>. An admin can finalize with \`/mm close_ticket ${tradeId}\`.`,
    });
  } catch (error) {
    console.error("Request cancel error:", error);
    await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
  }
}

async function handleAdjudicateButton(interaction, decision) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  if (!interaction.member.permissions.has("Administrator")) {
    return interaction.reply({ content: "Admin only.", flags: MessageFlags.Ephemeral });
  }

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    if (trade.status === "COMPLETED" || trade.status === "CANCELLED") {
      return interaction.reply({ content: `Trade already ${trade.status.toLowerCase()}.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

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

    await logAction(tradeId, interaction.user.id, "ADJUDICATED", { decision, amountReleased });

    try {
      await interaction.message.delete();
    } catch (e) {}

    const embed = new EmbedBuilder()
      .setTitle("Dispute Resolved")
      .setColor(0x00FF00)
      .setDescription(
        `Funds released to ${decision}.\n\n` +
        `<@${recipientId}> (${recipientMc}) receives **${formatAmount(amountReleased)}**.`
      )
      .setFooter({ text: `Resolved by ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("Adjudicate button error:", error);
    if (!interaction.replied) {
      await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
    }
  }
}

async function handleCloseDispute(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  if (!interaction.member.permissions.has("Administrator")) {
    return interaction.reply({ content: "Admin only.", flags: MessageFlags.Ephemeral });
  }

  try {
    await db.update(tickets).set({
      status: "CLOSED",
      updatedAt: new Date(),
    }).where(eq(tickets.tradeId, tradeId));

    await logAction(tradeId, interaction.user.id, "DISPUTE_CLOSED", {});

    await interaction.reply({ content: `Dispute #${tradeId} closed.` });
  } catch (error) {
    console.error("Close dispute error:", error);
    await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
  }
}

async function handleAttachEvidence(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const modal = new ModalBuilder()
      .setCustomId(`evidence_modal_${tradeId}`)
      .setTitle("Add Evidence")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("evidence")
            .setLabel("Evidence")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Paste screenshots, links, or describe the evidence...")
            .setRequired(true)
            .setMaxLength(2000)
        )
      );

    await interaction.showModal(modal);
  } catch (error) {
    console.error("Attach evidence error:", error);
    await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
  }
}
