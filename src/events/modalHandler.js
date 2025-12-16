import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } from "discord.js";
import { db } from "../db/index.js";
import { trades, tickets, verifications, botConfig, linkedAccounts } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { formatAmount, parseAmount } from "../utils/currencyParser.js";
import { logAction } from "../utils/auditLog.js";
import { 
  createRoleAssignmentEmbed,
  createRoleAssignmentButtons,
  createConfirmRolesEmbed,
  createConfirmRolesButtons,
  createAmountConfirmationEmbed,
  createAmountConfirmationButtons,
  deleteLastBotMessage,
  createVouchEmbed
} from "../ui/tradeChannel.js";
import { refreshPublicEmbed } from "../ui/publicEmbed.js";

const BOT_MC_USERNAME = process.env.MINECRAFT_USERNAME || "Bunji_MC";

export async function handleModalSubmit(interaction) {
  const customId = interaction.customId;

  if (customId.startsWith("scam_modal_")) {
    return handleScamModal(interaction);
  } else if (customId.startsWith("evidence_modal_")) {
    return handleEvidenceModal(interaction);
  } else if (customId.startsWith("mc_usernames_modal_")) {
    return handleMcUsernamesModal(interaction);
  } else if (customId.startsWith("review_modal_")) {
    return handleReviewModal(interaction);
  } else if (customId === "admin_fee_modal") {
    return handleAdminFeeModal(interaction);
  } else if (customId === "admin_limits_modal") {
    return handleAdminLimitsModal(interaction);
  }
}

async function handleMcUsernamesModal(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());
  const senderMc = interaction.fields.getTextInputValue("sender_mc").trim();
  const receiverMc = interaction.fields.getTextInputValue("receiver_mc").trim();

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    if (!/^[a-zA-Z0-9_]{3,16}$/.test(senderMc) || !/^[a-zA-Z0-9_]{3,16}$/.test(receiverMc)) {
      return interaction.reply({ 
        content: "Invalid Minecraft username! Usernames must be 3-16 characters using only letters, numbers, and underscores.", 
        flags: MessageFlags.Ephemeral 
      });
    }

    await interaction.deferReply();

    await db.update(trades).set({
      sellerMc: senderMc,
      buyerMc: receiverMc,
      status: "ROLES_CONFIRMED",
      updatedAt: new Date(),
    }).where(eq(trades.id, tradeId));

    const confirmEmbed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle("Minecraft Usernames Confirmed")
      .addFields(
        { name: "Sender (Paying)", value: `\`${senderMc}\``, inline: true },
        { name: "Receiver (Getting Paid)", value: `\`${receiverMc}\``, inline: true }
      );

    await interaction.editReply({ embeds: [confirmEmbed] });

    const { createDealAmountEmbed } = await import("../ui/tradeChannel.js");
    const amountEmbed = createDealAmountEmbed();

    await interaction.channel.send({ 
      content: `<@${trade.sellerDiscordId}>`,
      embeds: [amountEmbed] 
    });

    await logAction(tradeId, interaction.user.id, "ROLES_CONFIRMED", { senderMc, receiverMc });
  } catch (error) {
    console.error("MC usernames modal error:", error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "Something went wrong. Please try again!" }).catch(() => {});
      } else {
        await interaction.reply({ content: "Something went wrong. Please try again!", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    } catch (replyError) {
      console.error("Could not send error response:", replyError);
    }
  }
}

export async function handlePartnerMention(message) {
  if (message.author.bot) return;
  
  const channel = message.channel;
  if (!channel.name?.startsWith("trade-") && !channel.name?.startsWith("ticket-")) return;
  
  const mentionedUsers = message.mentions.users.filter(u => u.id !== message.author.id && !u.bot);
  if (mentionedUsers.size === 0) return;

  const otherUser = mentionedUsers.first();
  
  const existingTrade = await db.select().from(trades).where(eq(trades.threadId, channel.id)).limit(1);
  if (existingTrade.length > 0) return;

  try {
    await channel.permissionOverwrites.edit(otherUser.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });

    const addedEmbed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle("Partner Added!")
      .setDescription(`<@${otherUser.id}> has been added to this trade ticket.`);

    await channel.send({ embeds: [addedEmbed] });

    const [newTrade] = await db
      .insert(trades)
      .values({
        sellerDiscordId: message.author.id,
        buyerDiscordId: otherUser.id,
        sellerMc: "",
        buyerMc: "",
        saleAmount: "0.00",
        verificationAmountBuyer: "0.00",
        verificationAmountSeller: "0.00",
        status: "AWAITING_ROLES",
        threadId: channel.id,
      })
      .returning();

    await db.insert(tickets).values({
      tradeId: newTrade.id,
      channelId: channel.id,
      status: "OPEN",
    });

    const roleEmbed = createRoleAssignmentEmbed(newTrade);
    const roleButtons = createRoleAssignmentButtons(newTrade.id);

    await channel.send({ embeds: [roleEmbed], components: [roleButtons] });

    await logAction(newTrade.id, message.author.id, "TRADE_CREATED", {
      sellerDiscordId: message.author.id,
      buyerDiscordId: otherUser.id,
    });

  } catch (error) {
    console.error("Error handling partner mention:", error);
    await channel.send({ content: "Failed to add user to ticket. Please try again or contact support." });
  }
}

export async function handleAmountMessage(message) {
  if (message.author.bot) return;
  
  const channel = message.channel;
  if (!channel.name?.startsWith("trade-") && !channel.name?.startsWith("ticket-")) return;

  const [trade] = await db.select().from(trades).where(
    and(
      eq(trades.threadId, channel.id),
      eq(trades.status, "ROLES_CONFIRMED")
    )
  ).limit(1);

  if (!trade) return;

  if (message.author.id !== trade.sellerDiscordId) return;

  const amount = parseAmount(message.content.trim());
  if (!amount || amount <= 0) {
    const helpEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setDescription(
        `That doesn't look like a valid amount!\n\n` +
        `**Try formats like:**\n` +
        `> \`100\` for $100\n` +
        `> \`50k\` for $50,000\n` +
        `> \`2.5m\` for $2,500,000`
      );
    await channel.send({ embeds: [helpEmbed] });
    return;
  }

  try {
    await db.update(trades).set({
      saleAmount: amount.toFixed(2),
      updatedAt: new Date(),
    }).where(eq(trades.id, trade.id));

    const confirmEmbed = createAmountConfirmationEmbed(amount);
    const confirmButtons = createAmountConfirmationButtons(trade.id);

    await channel.send({ embeds: [confirmEmbed], components: [confirmButtons] });
  } catch (error) {
    console.error("Error handling amount message:", error);
  }
}

export async function handleMinecraftUsernameMessage(message) {
  if (message.author.bot) return;
  
  const channel = message.channel;
  if (!channel.name?.startsWith("trade-") && !channel.name?.startsWith("ticket-")) return;

  const [trade] = await db.select().from(trades).where(
    and(
      eq(trades.threadId, channel.id),
      eq(trades.status, "AWAITING_ROLES")
    )
  ).limit(1);

  if (!trade) return;

  const username = message.content.trim();
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) return;

  const userId = message.author.id;
  const updateData = { updatedAt: new Date() };

  if (userId === trade.sellerDiscordId && !trade.sellerMc) {
    updateData.sellerMc = username;
  } else if (userId === trade.buyerDiscordId && !trade.buyerMc) {
    updateData.buyerMc = username;
  } else {
    return;
  }

  try {
    await db.update(trades).set(updateData).where(eq(trades.id, trade.id));
    await message.react("✅");
  } catch (error) {
    console.error("Error handling Minecraft username:", error);
  }
}

async function handleScamModal(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());
  const reason = interaction.fields.getTextInputValue("reason");

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    const userId = interaction.user.id;

    if (trade.status === "COMPLETED" || trade.status === "CANCELLED") {
      return interaction.reply({ 
        content: `This trade has already been ${trade.status.toLowerCase()}.`, 
        flags: MessageFlags.Ephemeral 
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

    const reportEmbed = new EmbedBuilder()
      .setTitle("Dispute Opened")
      .setColor(0xED4245)
      .setDescription(`A dispute has been filed and all funds are now frozen.`)
      .addFields(
        { name: "Reported By", value: `<@${userId}>`, inline: true },
        { name: "Trade ID", value: `#${tradeId}`, inline: true },
        { name: "Status", value: "Frozen", inline: true },
        { name: "Trade Value", value: `$${parseFloat(trade.saleAmount).toFixed(2)}`, inline: true },
        { name: "Sender", value: `<@${trade.sellerDiscordId}>`, inline: true },
        { name: "Receiver", value: `<@${trade.buyerDiscordId}>`, inline: true },
        { name: "Reason", value: reason }
      )
      .setTimestamp();

    const staffButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`adj_seller_${tradeId}`)
        .setLabel("Return to Sender")
        .setStyle(ButtonStyle.Success)
        .setEmoji("↩️"),
      new ButtonBuilder()
        .setCustomId(`adj_buyer_${tradeId}`)
        .setLabel("Release to Receiver")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("💸"),
      new ButtonBuilder()
        .setCustomId(`attach_evidence_${tradeId}`)
        .setLabel("Add Evidence")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("📎")
    );

    let supportMention = "";
    if (config?.supportRoleId) {
      supportMention = `<@&${config.supportRoleId}> `;
      await db.update(tickets).set({ 
        supportRoleTagged: true, 
        updatedAt: new Date() 
      }).where(eq(tickets.tradeId, tradeId));
    }

    const replyMessage = await interaction.editReply({
      content: `${supportMention}A dispute has been opened for Trade #${tradeId}`,
      embeds: [reportEmbed],
      components: [staffButtons],
    });

    await deleteLastBotMessage(interaction.channel, replyMessage.id);

    if (config?.staffChannelId) {
      try {
        const staffChannel = await guild.channels.fetch(config.staffChannelId);
        if (staffChannel) {
          await staffChannel.send({
            content: `${supportMention}Dispute: Trade #${tradeId}`,
            embeds: [reportEmbed],
            components: [staffButtons],
          });
        }
      } catch (e) {
        console.error("Could not post to staff channel:", e);
      }
    }

    await logAction(tradeId, userId, "DISPUTE_OPENED", { reason });
    await refreshPublicEmbed(interaction.client, guild.id);
  } catch (error) {
    console.error("Scam modal error:", error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "Something went wrong while opening the dispute." }).catch(() => {});
      } else {
        await interaction.reply({ content: "Something went wrong while opening the dispute.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    } catch (replyError) {
      console.error("Could not send error response:", replyError);
    }
  }
}

async function handleEvidenceModal(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());
  const evidence = interaction.fields.getTextInputValue("evidence");

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    await logAction(tradeId, interaction.user.id, "EVIDENCE_ADDED", { evidence });

    const embed = new EmbedBuilder()
      .setTitle("Evidence Added")
      .setColor(0x5865F2)
      .addFields(
        { name: "Submitted By", value: `<@${interaction.user.id}>`, inline: true },
        { name: "Trade ID", value: `#${tradeId}`, inline: true },
        { name: "Evidence", value: evidence.substring(0, 1024) }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error("Evidence modal error:", error);
    await interaction.reply({ content: "Something went wrong. Please try again!", flags: MessageFlags.Ephemeral });
  }
}

async function handleReviewModal(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());
  const ratingStr = interaction.fields.getTextInputValue("rating").trim();
  const reviewText = interaction.fields.getTextInputValue("review").trim();

  const rating = parseInt(ratingStr);
  if (isNaN(rating) || rating < 1 || rating > 5) {
    return interaction.reply({ 
      content: "Please enter a valid rating between 1 and 5.", 
      flags: MessageFlags.Ephemeral 
    });
  }

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", flags: MessageFlags.Ephemeral });
    }

    const userId = interaction.user.id;
    if (trade.sellerDiscordId !== userId && trade.buyerDiscordId !== userId) {
      return interaction.reply({ 
        content: "Only trade participants can leave a review.", 
        flags: MessageFlags.Ephemeral 
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;
    const [config] = await db.select().from(botConfig).where(eq(botConfig.guildId, guild.id)).limit(1);

    if (!config?.vouchChannelId) {
      return interaction.editReply({ content: "Reviews are not set up yet. Please contact an admin." });
    }

    const vouchEmbed = createVouchEmbed(trade, userId, rating, reviewText);

    try {
      const vouchChannel = await guild.channels.fetch(config.vouchChannelId);
      if (vouchChannel) {
        await vouchChannel.send({ embeds: [vouchEmbed] });
      }
    } catch (e) {
      console.error("Could not post to vouch channel:", e);
      return interaction.editReply({ content: "Couldn't post your review. Please contact an admin." });
    }

    await logAction(tradeId, userId, "REVIEW_SUBMITTED", { rating, review: reviewText });

    await interaction.editReply({ 
      content: `Thanks for your review! Your ${rating}-star vouch has been posted.` 
    });

    try {
      await interaction.message.edit({ components: [] });
    } catch (e) {}

  } catch (error) {
    console.error("Review modal error:", error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "Something went wrong. Please try again!" });
      } else {
        await interaction.reply({ content: "Something went wrong. Please try again!", flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      console.error("Could not send error response:", e);
    }
  }
}

async function handleAdminFeeModal(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: "You don't have permission to do this.", flags: MessageFlags.Ephemeral });
  }

  const newFeeStr = interaction.fields.getTextInputValue("new_fee").trim();
  const newFee = parseFloat(newFeeStr);

  if (isNaN(newFee) || newFee < 0 || newFee > 100) {
    return interaction.reply({ 
      content: "Please enter a valid fee percentage between 0 and 100.", 
      flags: MessageFlags.Ephemeral 
    });
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guild.id;
    const [existing] = await db.select().from(botConfig).where(eq(botConfig.guildId, guildId)).limit(1);

    if (existing) {
      await db.update(botConfig).set({
        feePercent: newFee.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(botConfig.guildId, guildId));
    } else {
      await db.insert(botConfig).values({
        guildId,
        feePercent: newFee.toFixed(2),
      });
    }

    await refreshPublicEmbed(interaction.client, guildId);

    await interaction.editReply({ 
      content: `Service fee has been updated to **${newFee}%**. The public embed has been refreshed.` 
    });

    await logAction(null, interaction.user.id, "FEE_CHANGED", { newFee });
  } catch (error) {
    console.error("Admin fee modal error:", error);
    await interaction.editReply({ content: "Something went wrong while updating the fee." });
  }
}

async function handleAdminLimitsModal(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: "You don't have permission to do this.", flags: MessageFlags.Ephemeral });
  }

  const minAmountStr = interaction.fields.getTextInputValue("min_amount").trim();
  const maxAmountStr = interaction.fields.getTextInputValue("max_amount").trim();

  let minAmount = null;
  let maxAmount = null;

  if (minAmountStr) {
    minAmount = parseFloat(minAmountStr);
    if (isNaN(minAmount) || minAmount < 0) {
      return interaction.reply({ 
        content: "Please enter a valid minimum amount (0 or greater).", 
        flags: MessageFlags.Ephemeral 
      });
    }
  }

  if (maxAmountStr) {
    maxAmount = parseFloat(maxAmountStr);
    if (isNaN(maxAmount) || maxAmount < 0) {
      return interaction.reply({ 
        content: "Please enter a valid maximum amount (0 or greater).", 
        flags: MessageFlags.Ephemeral 
      });
    }
  }

  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    return interaction.reply({ 
      content: "Minimum amount cannot be greater than maximum amount.", 
      flags: MessageFlags.Ephemeral 
    });
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guild.id;
    const [existing] = await db.select().from(botConfig).where(eq(botConfig.guildId, guildId)).limit(1);

    const updateData = {
      minTradeAmount: minAmount !== null ? minAmount.toFixed(2) : "0.00",
      maxTradeAmount: maxAmount !== null ? maxAmount.toFixed(2) : null,
      updatedAt: new Date(),
    };

    if (existing) {
      await db.update(botConfig).set(updateData).where(eq(botConfig.guildId, guildId));
    } else {
      await db.insert(botConfig).values({
        guildId,
        ...updateData,
      });
    }

    let message = "Trade limits updated!\n";
    message += `**Minimum:** ${minAmount !== null && minAmount > 0 ? `$${minAmount.toFixed(2)}` : 'None'}\n`;
    message += `**Maximum:** ${maxAmount !== null ? `$${maxAmount.toFixed(2)}` : 'Unlimited'}`;

    await interaction.editReply({ content: message });

    await logAction(null, interaction.user.id, "LIMITS_CHANGED", { minAmount, maxAmount });
  } catch (error) {
    console.error("Admin limits modal error:", error);
    await interaction.editReply({ content: "Something went wrong while updating the limits." });
  }
}
