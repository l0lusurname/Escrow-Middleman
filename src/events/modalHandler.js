import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from "discord.js";
import { db } from "../db/index.js";
import { trades, tickets, verifications, botConfig, linkedAccounts } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { formatAmount, parseAmount, generateVerificationAmount } from "../utils/currencyParser.js";
import { logAction } from "../utils/auditLog.js";
import { createVerificationEmbed, createVerificationButtons } from "../ui/tradeChannel.js";
import { refreshPublicEmbed } from "../ui/publicEmbed.js";

const BOT_MC_USERNAME = process.env.MINECRAFT_USERNAME || "Bunji_MC";

export async function handleModalSubmit(interaction) {
  const customId = interaction.customId;

  if (customId.startsWith("scam_modal_")) {
    return handleScamModal(interaction);
  } else if (customId.startsWith("trade_setup_modal_")) {
    return handleTradeSetupModal(interaction);
  } else if (customId.startsWith("evidence_modal_")) {
    return handleEvidenceModal(interaction);
  }
}

async function handleTradeSetupModal(interaction) {
  const shortId = interaction.customId.replace("trade_setup_modal_", "");

  try {
    const yourRole = interaction.fields.getTextInputValue("your_role").trim().toLowerCase();
    const saleAmountStr = interaction.fields.getTextInputValue("sale_amount");
    const yourMc = interaction.fields.getTextInputValue("your_mc").trim();
    const otherMc = interaction.fields.getTextInputValue("other_mc").trim();
    const notes = interaction.fields.getTextInputValue("notes") || "";

    if (yourRole !== "seller" && yourRole !== "buyer") {
      return interaction.reply({
        content: "Please type either 'seller' or 'buyer' for your role.",
        ephemeral: true,
      });
    }

    const saleAmount = parseAmount(saleAmountStr);
    if (!saleAmount || saleAmount <= 0) {
      return interaction.reply({
        content: "Invalid sale amount. Please use a valid number (supports k/m/b suffixes).",
        ephemeral: true,
      });
    }

    if (!yourMc || !otherMc) {
      return interaction.reply({
        content: "Both Minecraft usernames are required.",
        ephemeral: true,
      });
    }

    if (yourMc.toLowerCase() === otherMc.toLowerCase()) {
      return interaction.reply({
        content: "Seller and buyer cannot be the same person.",
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    const channel = interaction.channel;
    const messages = await channel.messages.fetch({ limit: 10 });
    const mentionedUsers = [];
    
    for (const msg of messages.values()) {
      if (msg.mentions.users.size > 0) {
        msg.mentions.users.forEach((user) => {
          if (user.id !== interaction.user.id && user.id !== interaction.client.user.id) {
            mentionedUsers.push(user);
          }
        });
      }
    }

    const initiatorId = interaction.user.id;
    const otherPartyId = mentionedUsers[0]?.id;

    if (!otherPartyId) {
      return interaction.editReply({
        content: "Please tag the other party in this channel first, then click Setup Trade again.",
      });
    }

    const isSeller = yourRole === "seller";
    const sellerDiscordId = isSeller ? initiatorId : otherPartyId;
    const buyerDiscordId = isSeller ? otherPartyId : initiatorId;
    const sellerMc = isSeller ? yourMc : otherMc;
    const buyerMc = isSeller ? otherMc : yourMc;

    const verificationAmountBuyer = generateVerificationAmount();
    const verificationAmountSeller = generateVerificationAmount();

    const [newTrade] = await db
      .insert(trades)
      .values({
        sellerDiscordId,
        buyerDiscordId,
        sellerMc,
        buyerMc,
        saleAmount: saleAmount.toFixed(2),
        verificationAmountBuyer: verificationAmountBuyer.toFixed(2),
        verificationAmountSeller: verificationAmountSeller.toFixed(2),
        status: "AWAITING_VERIFICATION",
        threadId: channel.id,
      })
      .returning();

    await db.insert(tickets).values({
      tradeId: newTrade.id,
      channelId: channel.id,
      status: "OPEN",
    });

    try {
      await channel.permissionOverwrites.edit(otherPartyId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
    } catch (e) {
      console.error("Could not add other party to channel:", e);
    }

    const embed = createVerificationEmbed(newTrade, false, false);
    const buttons = createVerificationButtons(newTrade.id, false, false);

    await interaction.editReply({
      content: `Trade #${newTrade.id} created! <@${sellerDiscordId}> <@${buyerDiscordId}>`,
      embeds: [embed],
      components: buttons,
    });

    if (notes) {
      await channel.send({
        content: `**Trade Notes:** ${notes}`,
      });
    }

    await logAction(newTrade.id, initiatorId, "TRADE_CREATED", {
      sellerDiscordId,
      buyerDiscordId,
      sellerMc,
      buyerMc,
      saleAmount,
      verificationAmountBuyer,
      verificationAmountSeller,
      notes,
    });

    await refreshPublicEmbed(interaction.client, interaction.guild.id);
  } catch (error) {
    console.error("Trade setup modal error:", error);
    if (interaction.deferred) {
      await interaction.editReply({ content: "An error occurred while creating the trade." });
    } else {
      await interaction.reply({ content: "An error occurred.", ephemeral: true });
    }
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

    await refreshPublicEmbed(interaction.client, guild.id);
  } catch (error) {
    console.error("Scam modal error:", error);
    if (interaction.deferred) {
      await interaction.editReply({ content: "An error occurred while reporting the scam." });
    } else {
      await interaction.reply({ content: "An error occurred.", ephemeral: true });
    }
  }
}

async function handleEvidenceModal(interaction) {
  const tradeId = parseInt(interaction.customId.split("_").pop());
  const evidence = interaction.fields.getTextInputValue("evidence");

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: "Trade not found.", ephemeral: true });
    }

    await logAction(tradeId, interaction.user.id, "EVIDENCE_ATTACHED", { evidence });

    const embed = new EmbedBuilder()
      .setTitle(`Evidence Attached - Trade #${tradeId}`)
      .setColor(0x00AE86)
      .addFields(
        { name: "Submitted By", value: `<@${interaction.user.id}>`, inline: true },
        { name: "Trade ID", value: `#${tradeId}`, inline: true },
        { name: "Evidence", value: evidence.substring(0, 1024) }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error("Evidence modal error:", error);
    await interaction.reply({ content: "An error occurred.", ephemeral: true });
  }
}
