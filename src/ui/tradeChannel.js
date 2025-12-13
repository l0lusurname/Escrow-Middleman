import {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";
import { db } from "../db/index.js";
import { trades, tickets, botConfig, linkedAccounts } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { generateVerificationAmount, formatAmount } from "../utils/currencyParser.js";
import { logAction } from "../utils/auditLog.js";

const BOT_MC_USERNAME = process.env.MINECRAFT_USERNAME || "Bunji_MC";
const FEE_PERCENT = parseFloat(process.env.FEE_PERCENT) || 5.0;

function generateShortId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export async function deleteLastBotMessage(channel, beforeMessageId = null) {
  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    const botMessages = messages.filter(m => m.author.bot && (!beforeMessageId || m.id !== beforeMessageId));
    const lastBotMessage = botMessages.first();
    if (lastBotMessage) {
      await lastBotMessage.delete().catch(() => {});
    }
  } catch (e) {
    console.error("Could not delete previous message:", e);
  }
}

export async function createTradeChannel(interaction) {
  const guild = interaction.guild;
  const user = interaction.user;
  const shortId = generateShortId();

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const [config] = await db.select().from(botConfig).where(eq(botConfig.guildId, guild.id)).limit(1);

    const overwrites = [
      {
        id: guild.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
      {
        id: interaction.client.user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages],
      },
    ];

    if (config?.supportRoleId) {
      overwrites.push({
        id: config.supportRoleId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      });
    }

    const channel = await guild.channels.create({
      name: `trade-${shortId}`,
      type: ChannelType.GuildText,
      permissionOverwrites: overwrites,
      reason: `Trade channel for ${user.tag}`,
    });

    const welcomeEmbed = new EmbedBuilder()
      .setTitle("New Trade")
      .setColor(0x5865F2)
      .setDescription(
        `Tag the person you want to trade with, then click **Setup Trade** to continue.`
      )
      .addFields(
        { name: "Created by", value: `<@${user.id}>`, inline: true },
        { name: "Status", value: "Waiting for setup", inline: true }
      )
      .setFooter({ text: `ID: ${shortId}` })
      .setTimestamp();

    const setupButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`setup_trade_${shortId}`)
        .setLabel("Setup Trade")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`cancel_trade_${shortId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
    );

    await channel.send({ embeds: [welcomeEmbed], components: [setupButtons] });

    await interaction.editReply({
      content: `Your trade channel has been created: ${channel}`,
    });

    return channel;
  } catch (error) {
    console.error("Error creating trade channel:", error);
    if (interaction.deferred) {
      await interaction.editReply({ content: "Failed to create trade channel. Please try again." });
    }
    return null;
  }
}

export function createTradeSetupModal(shortId) {
  return new ModalBuilder()
    .setCustomId(`trade_setup_modal_${shortId}`)
    .setTitle("Trade Setup")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("your_role")
          .setLabel("Are you the SELLER or BUYER?")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("seller or buyer")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("sale_amount")
          .setLabel("Sale Amount")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g., 1000, 5k, 1.5M")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("your_mc")
          .setLabel("Your Minecraft Username")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("other_mc")
          .setLabel("Other Party's Minecraft Username")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("notes")
          .setLabel("What is being traded? (Optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
      )
    );
}

export function createSellerVerificationEmbed(trade) {
  const saleAmount = parseFloat(trade.saleAmount);
  const feeAmount = saleAmount * (FEE_PERCENT / 100);
  const sellerReceives = saleAmount - feeAmount;

  const embed = new EmbedBuilder()
    .setTitle("Seller Verification Required")
    .setColor(0xFFA500)
    .setDescription(
      `<@${trade.sellerDiscordId}>, pay the verification amount below to confirm you're the seller.`
    )
    .addFields(
      { name: "Amount to Pay", value: `\`/pay ${BOT_MC_USERNAME} ${formatAmount(trade.verificationAmountSeller)}\``, inline: false },
      { name: "Sale Amount", value: formatAmount(saleAmount), inline: true },
      { name: "Fee (5%)", value: formatAmount(feeAmount), inline: true },
      { name: "You'll Receive", value: formatAmount(sellerReceives), inline: true }
    )
    .setFooter({ text: `Trade #${trade.id}` })
    .setTimestamp();

  return embed;
}

export function createBuyerVerificationEmbed(trade) {
  const embed = new EmbedBuilder()
    .setTitle("Buyer Verification Required")
    .setColor(0xFFA500)
    .setDescription(
      `<@${trade.buyerDiscordId}>, pay the verification amount below to confirm you're the buyer.`
    )
    .addFields(
      { name: "Amount to Pay", value: `\`/pay ${BOT_MC_USERNAME} ${formatAmount(trade.verificationAmountBuyer)}\``, inline: false },
      { name: "Sale Amount", value: formatAmount(trade.saleAmount), inline: true }
    )
    .setFooter({ text: `Trade #${trade.id}` })
    .setTimestamp();

  return embed;
}

export function createVerificationCompleteEmbed(trade, party) {
  const embed = new EmbedBuilder()
    .setTitle(`${party === 'seller' ? 'Seller' : 'Buyer'} Verified`)
    .setColor(0x00FF00)
    .setDescription(
      party === 'seller' 
        ? `<@${trade.sellerDiscordId}> has been verified.`
        : `<@${trade.buyerDiscordId}> has been verified.`
    )
    .setFooter({ text: `Trade #${trade.id}` })
    .setTimestamp();

  return embed;
}

export function createEscrowDepositEmbed(trade) {
  const saleAmount = parseFloat(trade.saleAmount);

  const embed = new EmbedBuilder()
    .setTitle("Deposit Required")
    .setColor(0xFFA500)
    .setDescription(
      `<@${trade.buyerDiscordId}>, deposit the sale amount to escrow to proceed.`
    )
    .addFields(
      { name: "Amount to Deposit", value: `\`/pay ${BOT_MC_USERNAME} ${formatAmount(saleAmount)}\``, inline: false },
      { name: "Seller", value: `<@${trade.sellerDiscordId}>`, inline: true },
      { name: "Buyer", value: `<@${trade.buyerDiscordId}>`, inline: true }
    )
    .setFooter({ text: `Trade #${trade.id}` })
    .setTimestamp();

  return embed;
}

export function createEscrowFundedEmbed(trade) {
  const saleAmount = parseFloat(trade.saleAmount);
  const feeAmount = saleAmount * (FEE_PERCENT / 100);
  const sellerReceives = saleAmount - feeAmount;

  const embed = new EmbedBuilder()
    .setTitle("Escrow Funded")
    .setColor(0x00FF00)
    .setDescription(
      `Funds are now held securely.\n\n` +
      `<@${trade.sellerDiscordId}>, deliver the goods to the buyer.\n` +
      `<@${trade.buyerDiscordId}>, confirm delivery once you receive everything.`
    )
    .addFields(
      { name: "In Escrow", value: formatAmount(saleAmount), inline: true },
      { name: "Seller Receives", value: formatAmount(sellerReceives), inline: true },
      { name: "Status", value: "Awaiting delivery confirmation", inline: true }
    )
    .setFooter({ text: `Trade #${trade.id}` })
    .setTimestamp();

  return embed;
}

export function createEscrowButtons(tradeId, inEscrow) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_delivered_${tradeId}`)
      .setLabel("Confirm Delivery")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!inEscrow),
    new ButtonBuilder()
      .setCustomId(`mark_scammed_${tradeId}`)
      .setLabel("Report Issue")
      .setStyle(ButtonStyle.Danger)
  );
}

export function createVerificationButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mark_scammed_${tradeId}`)
      .setLabel("Report Issue")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`cancel_trade_db_${tradeId}`)
      .setLabel("Cancel Trade")
      .setStyle(ButtonStyle.Secondary)
  );
}

export function createDepositButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mark_scammed_${tradeId}`)
      .setLabel("Report Issue")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`cancel_trade_db_${tradeId}`)
      .setLabel("Cancel Trade")
      .setStyle(ButtonStyle.Secondary)
  );
}

export function createCompletedEmbed(trade, feeAmount, sellerReceives) {
  const embed = new EmbedBuilder()
    .setTitle("Trade Completed")
    .setColor(0x00FF00)
    .setDescription(
      `Trade has been completed successfully!\n\n` +
      `<@${trade.sellerDiscordId}>, you will receive **${formatAmount(sellerReceives)}**.`
    )
    .addFields(
      { name: "Sale Amount", value: formatAmount(trade.saleAmount), inline: true },
      { name: "Fee", value: formatAmount(feeAmount), inline: true },
      { name: "Seller Receives", value: formatAmount(sellerReceives), inline: true }
    )
    .setFooter({ text: `Trade #${trade.id}` })
    .setTimestamp();

  return embed;
}

export function createDisputeEmbed(trade, reason) {
  const embed = new EmbedBuilder()
    .setTitle("Dispute Opened")
    .setColor(0xFF0000)
    .setDescription(
      `A dispute has been opened for this trade. Staff will review shortly.`
    )
    .addFields(
      { name: "Trade", value: `#${trade.id}`, inline: true },
      { name: "Status", value: "Frozen", inline: true },
      { name: "Reason", value: reason || "No reason provided" }
    )
    .setFooter({ text: "Staff will resolve this dispute" })
    .setTimestamp();

  return embed;
}

export function createDisputeButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
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
}

export function createVerificationEmbed(trade, sellerVerified = false, buyerVerified = false) {
  const saleAmount = parseFloat(trade.saleAmount);
  const feeAmount = saleAmount * (FEE_PERCENT / 100);
  const sellerReceives = saleAmount - feeAmount;

  const sellerStatus = sellerVerified ? "Verified" : "Pending";
  const buyerStatus = buyerVerified ? "Verified" : "Pending";

  const embed = new EmbedBuilder()
    .setTitle(`Trade #${trade.id}`)
    .setColor(sellerVerified && buyerVerified ? 0x00FF00 : 0xFFA500)
    .setDescription(
      `Both parties must pay their verification amount to \`${BOT_MC_USERNAME}\`.`
    )
    .addFields(
      { name: "Sale Amount", value: formatAmount(saleAmount), inline: true },
      { name: "Fee (5%)", value: formatAmount(feeAmount), inline: true },
      { name: "Seller Receives", value: formatAmount(sellerReceives), inline: true },
      {
        name: `Seller (${trade.sellerMc})`,
        value: `Pay: \`${formatAmount(trade.verificationAmountSeller)}\`\nStatus: ${sellerStatus}`,
        inline: true,
      },
      {
        name: `Buyer (${trade.buyerMc})`,
        value: `Pay: \`${formatAmount(trade.verificationAmountBuyer)}\`\nStatus: ${buyerStatus}`,
        inline: true,
      }
    )
    .setFooter({ text: `Pay to: ${BOT_MC_USERNAME}` })
    .setTimestamp();

  return embed;
}

export function createEscrowEmbed(trade) {
  const saleAmount = parseFloat(trade.saleAmount);
  const escrowBalance = parseFloat(trade.escrowBalance) || 0;
  const feeAmount = saleAmount * (FEE_PERCENT / 100);
  const sellerReceives = saleAmount - feeAmount;
  const inEscrow = escrowBalance >= saleAmount;

  const embed = new EmbedBuilder()
    .setTitle(`Trade #${trade.id}`)
    .setColor(inEscrow ? 0x00FF00 : 0xFFA500)
    .setDescription(
      inEscrow
        ? `Escrow funded. Buyer can confirm delivery when ready.`
        : `Buyer: Deposit \`${formatAmount(saleAmount)}\` to \`${BOT_MC_USERNAME}\`.`
    )
    .addFields(
      { name: "Sale Amount", value: formatAmount(saleAmount), inline: true },
      { name: "In Escrow", value: formatAmount(escrowBalance), inline: true },
      { name: "Status", value: inEscrow ? "Funded" : "Awaiting deposit", inline: true }
    )
    .setFooter({ text: `Trade #${trade.id}` })
    .setTimestamp();

  return embed;
}
