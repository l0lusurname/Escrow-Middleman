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
  deleteLastBotMessage 
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
