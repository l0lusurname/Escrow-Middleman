import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionFlagsBits } from "discord.js";
import { db } from "../db/index.js";
import { trades, tickets, botConfig } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { formatAmount, parseAmount } from "../utils/currencyParser.js";
import { logAction } from "../utils/auditLog.js";
import { 
  createTradeChannel,
  createRoleAssignmentEmbed,
  createRoleAssignmentButtons,
  createConfirmRolesEmbed,
  createConfirmRolesButtons,
  createDealAmountEmbed,
  createAmountConfirmationEmbed,
  createAmountConfirmationButtons,
  createDealSummaryEmbed,
  createPaymentInvoiceEmbed,
  createCopyDetailsButton,
  createAwaitingPaymentEmbed,
  createProceedWithDealEmbed,
  createReleaseButtons,
  createReleaseConfirmationEmbed,
  createReleaseConfirmButtons,
  createSupportNotificationEmbed,
  createCompletedEmbed,
  createDisputeEmbed,
  createDisputeButtons,
  createEscrowButtons,
  deleteLastBotMessage,
  createReviewPromptEmbed,
  createReviewButton
} from "../ui/tradeChannel.js";
import { refreshPublicEmbed, postOrUpdatePublicEmbed } from "../ui/publicEmbed.js";
import { minecraftBot } from "../minecraft/mineflayer.js";
import {
  getGuildConfig,
  getGuildFeePercent,
  getDailyStats,
  createAdminPanelEmbed,
  createAdminPanelButtons,
  createChangeFeeModal,
  createSetLimitsModal,
  createChannelConfigEmbed,
  createCloseTicketPromptEmbed,
  createCloseTicketButton
} from "../ui/adminPanel.js";

const BOT_MC_USERNAME = process.env.MINECRAFT_USERNAME || "Bunji_MC";

export async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;

  if (customId === "start_middleman") {
    return handleStartMiddleman(interaction);
  } else if (customId.startsWith("close_ticket_") || customId.startsWith("close_completed_ticket_")) {
    return handleCloseTicket(interaction);
  } else if (customId.startsWith("role_sending_") || customId.startsWith("role_receiving_")) {
    return handleRoleSelection(interaction);
  } else if (customId.startsWith("role_reset_")) {
    return handleRoleReset(interaction);
  } else if (customId.startsWith("roles_correct_")) {
    return handleRolesCorrect(interaction);
  } else if (customId.startsWith("roles_incorrect_")) {
    return handleRolesIncorrect(interaction);
  } else if (customId.startsWith("amount_confirm_")) {
    return handleAmountConfirm(interaction);
  } else if (customId.startsWith("amount_incorrect_")) {
    return handleAmountIncorrect(interaction);
  } else if (customId.startsWith("copy_details_")) {
    return handleCopyDetails(interaction);
  } else if (customId.startsWith("release_funds_")) {
    return handleReleaseFunds(interaction);
  } else if (customId.startsWith("cancel_deal_")) {
    return handleCancelDeal(interaction);
  } else if (customId.startsWith("confirm_release_")) {
    return handleConfirmRelease(interaction);
  } else if (customId.startsWith("back_release_")) {
    return handleBackRelease(interaction);
  } else if (customId.startsWith("adj_seller_")) {
    return handleAdjudicateButton(interaction, "seller");
  } else if (customId.startsWith("adj_buyer_")) {
    return handleAdjudicateButton(interaction, "buyer");
  } else if (customId.startsWith("attach_evidence_")) {
    return handleAttachEvidence(interaction);
  } else if (customId.startsWith("mark_scammed_")) {
    return handleMarkScammedButton(interaction);
  } else if (customId.startsWith("leave_review_")) {
    return handleLeaveReview(interaction);
  } else if (customId === "admin_change_fee") {
    return handleAdminChangeFee(interaction);
  } else if (customId === "admin_set_limits") {
    return handleAdminSetLimits(interaction);
  } else if (customId === "admin_refresh_stats") {
    return handleAdminRefreshStats(interaction);
  } else if (customId === "admin_view_channels") {
    return handleAdminViewChannels(interaction);
  } else if (customId === "admin_post_embed") {
    return handleAdminPostEmbed(interaction);
  }
}

async function handleStartMiddleman(interaction) {
  try {
    await createTradeChannel(interaction);
  } catch (error) {
    console.error("Start middleman error:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Something went wrong! Please try again in a moment.", flags: MessageFlags.Ephemeral });
    }
  }
}

async function handleCloseTicket(interaction) {
  try {
    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle("Ticket Closing")
      .setDescription("This ticket will close in **10 seconds**...\n\nThanks for using Donut SMP Middleman!");

    await interaction.reply({ embeds: [embed] });
    setTimeout(async () => {
      try {
        await interaction.channel.delete("Ticket closed by user");
      } catch (e) {
        console.error("Could not delete channel:", e);
      }
    }, 10000);
  } catch (error) {
    console.error("Close ticket error:", error);
  }
}

async function handleRoleSelection(interaction) {
  const parts = interaction.customId.split("_");
  const role = parts[1];
  const tradeId = parseInt(parts[2]);

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    const userId = interaction.user.id;
    const user1 = trade.sellerDiscordId;
    const user2 = trade.buyerDiscordId;
    
    if (userId !== user1 && userId !== user2) {
      return interaction.reply({ content: "Only trade participants can select roles.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    const clickedSending = role === "sending";
    
    let newSender, newReceiver;
    
    if (clickedSending) {
      newSender = userId;
      newReceiver = userId === user1 ? user2 : user1;
    } else {
      newReceiver = userId;
      newSender = userId === user1 ? user2 : user1;
    }

    await db.update(trades).set({
      sellerDiscordId: newSender,
      buyerDiscordId: newReceiver,
      updatedAt: new Date(),
    }).where(eq(trades.id, tradeId));

    const [updatedTrade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);
    
    try {
      await interaction.message.delete();
    } catch (e) {}

    const confirmEmbed = createConfirmRolesEmbed(updatedTrade);
    const confirmButtons = createConfirmRolesButtons(tradeId);

    await interaction.channel.send({ 
      content: `<@${updatedTrade.sellerDiscordId}> <@${updatedTrade.buyerDiscordId}>`,
      embeds: [confirmEmbed], 
      components: [confirmButtons] 
    });
  } catch (error) {
    console.error("Role selection error:", error);
  }
}

async function handleRoleReset(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    const embed = createRoleAssignmentEmbed(trade);
    const buttons = createRoleAssignmentButtons(tradeId);

    await interaction.editReply({ embeds: [embed], components: [buttons] });
  } catch (error) {
    console.error("Role reset error:", error);
  }
}

async function handleRolesCorrect(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    const modal = new ModalBuilder()
      .setCustomId(`mc_usernames_modal_${tradeId}`)
      .setTitle("Enter Minecraft Usernames")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("sender_mc")
            .setLabel("Sender's Minecraft Username")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("The person PAYING money")
            .setRequired(true)
            .setMaxLength(16)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("receiver_mc")
            .setLabel("Receiver's Minecraft Username")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("The person GETTING money")
            .setRequired(true)
            .setMaxLength(16)
        )
      );

    await interaction.showModal(modal);
  } catch (error) {
    console.error("Roles correct error:", error);
  }
}

async function handleRolesIncorrect(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    try {
      await interaction.message.delete();
    } catch (e) {}

    const embed = createRoleAssignmentEmbed(trade);
    const buttons = createRoleAssignmentButtons(tradeId);

    await interaction.channel.send({ embeds: [embed], components: [buttons] });
  } catch (error) {
    console.error("Roles incorrect error:", error);
  }
}

async function handleAmountConfirm(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    if (trade.sellerDiscordId !== interaction.user.id) {
      return interaction.reply({ content: "Only the sender can confirm the amount.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    await db.update(trades).set({
      status: "AWAITING_PAYMENT",
      updatedAt: new Date(),
    }).where(eq(trades.id, tradeId));

    try {
      await interaction.message.delete();
    } catch (e) {}

    const feePercent = await getGuildFeePercent(interaction.guild.id);
    const summaryEmbed = createDealSummaryEmbed(trade, feePercent);
    const invoiceEmbed = createPaymentInvoiceEmbed(trade);
    const copyButton = createCopyDetailsButton(tradeId);
    const awaitingEmbed = createAwaitingPaymentEmbed();

    await interaction.channel.send({ 
      content: `<@${trade.sellerDiscordId}> <@${trade.buyerDiscordId}>`,
      embeds: [summaryEmbed] 
    });

    await interaction.channel.send({ 
      embeds: [invoiceEmbed],
      components: [copyButton]
    });

    await interaction.channel.send({ embeds: [awaitingEmbed] });

    await logAction(tradeId, interaction.user.id, "AMOUNT_CONFIRMED", { amount: trade.saleAmount });
  } catch (error) {
    console.error("Amount confirm error:", error);
  }
}

async function handleAmountIncorrect(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    try {
      await interaction.message.delete();
    } catch (e) {}

    const amountEmbed = createDealAmountEmbed();
    await interaction.channel.send({ 
      content: `<@${trade.sellerDiscordId}>`,
      embeds: [amountEmbed] 
    });
  } catch (error) {
    console.error("Amount incorrect error:", error);
  }
}

async function handleCopyDetails(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    const saleAmount = parseFloat(trade.saleAmount).toFixed(2);
    const payCommand = `/pay ${BOT_MC_USERNAME} ${saleAmount}`;

    await interaction.reply({
      content: `**Copy this command and use it in Donut SMP:**\n\`\`\`${payCommand}\`\`\``,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.error("Copy details error:", error);
    await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
  }
}

async function handleReleaseFunds(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    if (trade.sellerDiscordId !== interaction.user.id) {
      return interaction.reply({ content: "Only the sender can release funds.", flags: MessageFlags.Ephemeral });
    }

    if (trade.status !== "IN_ESCROW") {
      return interaction.reply({ content: "Payment must be deposited first.", flags: MessageFlags.Ephemeral });
    }

    if (trade.frozen) {
      return interaction.reply({ content: "This trade is frozen due to a dispute.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    const feePercent = await getGuildFeePercent(interaction.guild.id);
    const supportEmbed = createSupportNotificationEmbed();
    const releaseEmbed = createReleaseConfirmationEmbed(trade, feePercent);
    const releaseButtons = createReleaseConfirmButtons(tradeId);

    await interaction.channel.send({ embeds: [supportEmbed] });
    await interaction.channel.send({ 
      content: `<@${trade.sellerDiscordId}>`,
      embeds: [releaseEmbed], 
      components: [releaseButtons] 
    });
  } catch (error) {
    console.error("Release funds error:", error);
    if (!interaction.replied) {
      await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
    }
  }
}

async function handleCancelDeal(interaction) {
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
      .setTitle("Report an Issue")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("reason")
            .setLabel("What went wrong?")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Describe the issue in detail...")
            .setRequired(true)
            .setMaxLength(1000)
        )
      );

    await interaction.showModal(modal);
  } catch (error) {
    console.error("Cancel deal error:", error);
    await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
  }
}

async function handleConfirmRelease(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    if (trade.sellerDiscordId !== interaction.user.id) {
      return interaction.reply({ content: "Only the sender can confirm release.", flags: MessageFlags.Ephemeral });
    }

    if (trade.status !== "IN_ESCROW") {
      return interaction.reply({ content: "Payment must be in escrow first.", flags: MessageFlags.Ephemeral });
    }

    if (trade.frozen) {
      return interaction.reply({ content: "This trade is frozen due to a dispute.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    const guild = interaction.guild;
    const feePercent = await getGuildFeePercent(guild.id);
    
    const saleAmount = parseFloat(trade.saleAmount);
    const feeAmount = saleAmount * (feePercent / 100);
    const receiverGets = saleAmount - feeAmount;

    await db.update(trades).set({
      status: "COMPLETED",
      feeAmount: feeAmount.toFixed(2),
      feePercent: feePercent.toFixed(2),
      escrowBalance: "0.00",
      updatedAt: new Date(),
    }).where(eq(trades.id, tradeId));

    await db.update(tickets).set({
      status: "CLOSED",
      updatedAt: new Date(),
    }).where(eq(tickets.tradeId, tradeId));

    if (minecraftBot.isConnected()) {
      const payCommand = `/pay ${trade.buyerMc} ${receiverGets.toFixed(2)}`;
      minecraftBot.sendChat(payCommand);
      console.log(`Sent Minecraft payment: ${payCommand}`);
    } else {
      console.error("Minecraft bot not connected - could not send payment");
    }

    await logAction(tradeId, interaction.user.id, "FUNDS_RELEASED", { feeAmount, receiverGets, feePercent });

    try {
      await interaction.message.delete();
    } catch (e) {}

    const completedEmbed = createCompletedEmbed(trade, feeAmount, receiverGets);

    await interaction.channel.send({
      content: `<@${trade.sellerDiscordId}> <@${trade.buyerDiscordId}>`,
      embeds: [completedEmbed],
    });

    const [config] = await db.select().from(botConfig).where(eq(botConfig.guildId, guild.id)).limit(1);

    if (config?.vouchChannelId) {
      const reviewEmbed = createReviewPromptEmbed(trade);
      const reviewButton = createReviewButton(tradeId);
      await interaction.channel.send({ 
        embeds: [reviewEmbed], 
        components: [reviewButton] 
      });
    }

    const closePromptEmbed = createCloseTicketPromptEmbed();
    const closeButton = createCloseTicketButton(tradeId);
    await interaction.channel.send({
      embeds: [closePromptEmbed],
      components: [closeButton]
    });

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
    console.error("Confirm release error:", error);
    if (!interaction.replied) {
      await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
    }
  }
}

async function handleBackRelease(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    try {
      await interaction.message.delete();
    } catch (e) {}

    const proceedEmbed = createProceedWithDealEmbed(trade);
    const releaseButtons = createReleaseButtons(tradeId);

    await interaction.channel.send({ 
      embeds: [proceedEmbed], 
      components: [releaseButtons] 
    });
  } catch (error) {
    console.error("Back release error:", error);
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

async function handleAdjudicateButton(interaction, decision) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  if (!interaction.member.permissions.has("Administrator")) {
    return interaction.reply({ content: "Only admins can resolve disputes.", flags: MessageFlags.Ephemeral });
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

    const feePercent = await getGuildFeePercent(interaction.guild.id);
    const saleAmount = parseFloat(trade.saleAmount);
    const feeAmount = saleAmount * (feePercent / 100);

    let recipientId, recipientMc, amountReleased;

    if (decision === "seller") {
      recipientId = trade.sellerDiscordId;
      recipientMc = trade.sellerMc;
      amountReleased = saleAmount;
    } else {
      recipientId = trade.buyerDiscordId;
      recipientMc = trade.buyerMc;
      amountReleased = saleAmount - feeAmount;
    }

    await db.update(trades).set({
      status: "COMPLETED",
      frozen: false,
      feeAmount: decision === "buyer" ? feeAmount.toFixed(2) : "0.00",
      updatedAt: new Date(),
    }).where(eq(trades.id, tradeId));

    await db.update(tickets).set({
      status: "CLOSED",
      updatedAt: new Date(),
    }).where(eq(tickets.tradeId, tradeId));

    if (minecraftBot.isConnected()) {
      const payCommand = `/pay ${recipientMc} ${amountReleased.toFixed(2)}`;
      minecraftBot.sendChat(payCommand);
      console.log(`Sent Minecraft payment: ${payCommand}`);
    } else {
      console.error("Minecraft bot not connected - could not send payment");
    }

    await logAction(tradeId, interaction.user.id, "ADJUDICATED", { decision, amountReleased });

    try {
      await interaction.message.delete();
    } catch (e) {}

    const embed = new EmbedBuilder()
      .setTitle("Dispute Resolved")
      .setColor(0x57F287)
      .setDescription(
        `**Funds have been released to the ${decision === "seller" ? "sender" : "receiver"}.**\n\n` +
        `<@${recipientId}> (\`${recipientMc}\`) will receive **$${amountReleased.toFixed(2)}** in Donut SMP.`
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
            .setLabel("Evidence Details")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Paste screenshots links, transaction IDs, or describe what happened...")
            .setRequired(true)
            .setMaxLength(1000)
        )
      );

    await interaction.showModal(modal);
  } catch (error) {
    console.error("Attach evidence error:", error);
    await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
  }
}

async function handleLeaveReview(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    const userId = interaction.user.id;
    if (trade.sellerDiscordId !== userId && trade.buyerDiscordId !== userId) {
      return interaction.reply({ content: "Only trade participants can leave a review.", flags: MessageFlags.Ephemeral });
    }

    const modal = new ModalBuilder()
      .setCustomId(`review_modal_${tradeId}`)
      .setTitle("Leave a Review")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("rating")
            .setLabel("Rating (1-5 stars)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("Enter a number from 1 to 5")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(1)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("review")
            .setLabel("Your Review")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("How was your experience with the middleman service?")
            .setRequired(true)
            .setMaxLength(500)
        )
      );

    await interaction.showModal(modal);
  } catch (error) {
    console.error("Leave review error:", error);
    await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
  }
}

async function handleAdminChangeFee(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: "You don't have permission to do this.", flags: MessageFlags.Ephemeral });
  }

  try {
    const modal = createChangeFeeModal();
    await interaction.showModal(modal);
  } catch (error) {
    console.error("Admin change fee error:", error);
    await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
  }
}

async function handleAdminSetLimits(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: "You don't have permission to do this.", flags: MessageFlags.Ephemeral });
  }

  try {
    const config = await getGuildConfig(interaction.guild.id);
    const modal = createSetLimitsModal(config);
    await interaction.showModal(modal);
  } catch (error) {
    console.error("Admin set limits error:", error);
    await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
  }
}

async function handleAdminRefreshStats(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: "You don't have permission to do this.", flags: MessageFlags.Ephemeral });
  }

  try {
    await interaction.deferUpdate();
    const stats = await getDailyStats(interaction.guild.id);
    const config = await getGuildConfig(interaction.guild.id);
    const embed = createAdminPanelEmbed(stats, config);
    const buttons = createAdminPanelButtons();
    await interaction.editReply({ embeds: [embed], components: buttons });
  } catch (error) {
    console.error("Admin refresh stats error:", error);
    if (!interaction.replied) {
      await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
    }
  }
}

async function handleAdminViewChannels(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: "You don't have permission to do this.", flags: MessageFlags.Ephemeral });
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const config = await getGuildConfig(interaction.guild.id);
    const embed = createChannelConfigEmbed(config, interaction.guild);
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error("Admin view channels error:", error);
    await interaction.editReply({ content: "An error occurred." });
  }
}

async function handleAdminPostEmbed(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: "You don't have permission to do this.", flags: MessageFlags.Ephemeral });
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const message = await postOrUpdatePublicEmbed(interaction.client, interaction.guild.id);
    if (message) {
      await interaction.editReply({ content: "Public middleman embed posted/updated successfully!" });
    } else {
      await interaction.editReply({ content: "Failed to post embed. Make sure you've set the middleman channel with `/mm set_mm_channel` first." });
    }
  } catch (error) {
    console.error("Admin post embed error:", error);
    await interaction.editReply({ content: "An error occurred while posting the embed." });
  }
}
