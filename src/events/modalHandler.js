import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } from "discord.js";
import { db } from "../db/index.js";
import { trades, tickets, verifications, botConfig, linkedAccounts } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { formatAmount, parseAmount, generateVerificationAmount } from "../utils/currencyParser.js";
import { logAction } from "../utils/auditLog.js";
import { createVerificationEmbed, createVerificationButtons, deleteLastBotMessage } from "../ui/tradeChannel.js";
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
        content: "Please type exactly **seller** or **buyer** in the role field. Nothing else will work!",
        flags: MessageFlags.Ephemeral,
      });
    }

    const saleAmount = parseAmount(saleAmountStr);
    if (!saleAmount || saleAmount <= 0) {
      return interaction.reply({
        content: "That amount doesn't look right. Try something like: **5000**, **50k**, **2.5m**, or **1b**",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!yourMc || !otherMc) {
      return interaction.reply({
        content: "You need to fill in both Minecraft usernames - yours and your trading partner's.",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (yourMc.toLowerCase() === otherMc.toLowerCase()) {
      return interaction.reply({
        content: "The two Minecraft names can't be the same - you need your name AND your trading partner's name.",
        flags: MessageFlags.Ephemeral,
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
        content: "**Oops!** You need to @mention your trading partner in this channel first.\n\nJust type something like `@TheirName let's trade` then click the Setup Trade button again.",
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
    const buttons = createVerificationButtons(newTrade.id);

    const replyMessage = await interaction.editReply({
      content: `**Trade #${newTrade.id} is ready!**\n\nNow both of you need to verify your Minecraft accounts:\n\n<@${sellerDiscordId}> (Seller): Go in-game and type \`/pay ${BOT_MC_USERNAME} ${formatAmount(verificationAmountSeller)}\`\n<@${buyerDiscordId}> (Buyer): Go in-game and type \`/pay ${BOT_MC_USERNAME} ${formatAmount(verificationAmountBuyer)}\`\n\n_These are small verification amounts to prove you own the accounts._`,
      embeds: [embed],
      components: [buttons],
    });

    // Delete old bot messages AFTER our reply is sent, excluding our new message
    await deleteLastBotMessage(channel, replyMessage.id);

    if (notes) {
      await channel.send({ content: `**Notes:** ${notes}` });
    }

    await logAction(newTrade.id, initiatorId, "TRADE_CREATED", {
      sellerDiscordId,
      buyerDiscordId,
      sellerMc,
      buyerMc,
      saleAmount,
    });

    await refreshPublicEmbed(interaction.client, interaction.guild.id);
  } catch (error) {
    console.error("Trade setup modal error:", error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "An error occurred while setting up the trade." }).catch(() => {});
      } else {
        await interaction.reply({ content: "An error occurred while setting up the trade.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    } catch (replyError) {
      // Interaction expired, nothing we can do
      console.error("Could not send error response:", replyError);
    }
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
        content: `Trade already ${trade.status.toLowerCase()}.`, 
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
      .setColor(0xFF0000)
      .addFields(
        { name: "Reported By", value: `<@${userId}>`, inline: true },
        { name: "Trade", value: `#${tradeId}`, inline: true },
        { name: "Status", value: "Frozen", inline: true },
        { name: "Sale Amount", value: formatAmount(trade.saleAmount), inline: true },
        { name: "Seller", value: `<@${trade.sellerDiscordId}>`, inline: true },
        { name: "Buyer", value: `<@${trade.buyerDiscordId}>`, inline: true },
        { name: "Reason", value: reason }
      )
      .setTimestamp();

    const staffButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`adj_seller_${tradeId}`)
        .setLabel("Release to Seller")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`adj_buyer_${tradeId}`)
        .setLabel("Refund Buyer")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`attach_evidence_${tradeId}`)
        .setLabel("Add Evidence")
        .setStyle(ButtonStyle.Secondary)
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
      content: `${supportMention}Dispute opened for Trade #${tradeId}`,
      embeds: [reportEmbed],
      components: [staffButtons],
    });

    // Delete old bot messages AFTER our reply, excluding our new message
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
        await interaction.editReply({ content: "An error occurred while opening the dispute." }).catch(() => {});
      } else {
        await interaction.reply({ content: "An error occurred while opening the dispute.", flags: MessageFlags.Ephemeral }).catch(() => {});
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
        { name: "From", value: `<@${interaction.user.id}>`, inline: true },
        { name: "Trade", value: `#${tradeId}`, inline: true },
        { name: "Evidence", value: evidence.substring(0, 1024) }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error("Evidence modal error:", error);
    await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
  }
}
