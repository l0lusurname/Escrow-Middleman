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

export async function createTradeChannel(interaction) {
  const guild = interaction.guild;
  const user = interaction.user;
  const shortId = generateShortId();

  try {
    await interaction.deferReply({ ephemeral: true });

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
      name: `mm-${shortId}`,
      type: ChannelType.GuildText,
      permissionOverwrites: overwrites,
      reason: `Middleman trade channel for ${user.tag}`,
    });

    const welcomeEmbed = new EmbedBuilder()
      .setTitle(`🤝 Middleman Trade - ${shortId}`)
      .setColor(0x00AE86)
      .setDescription(
        `Welcome to your private trade channel!\n\n` +
        `**Step 1:** Tag the person you want to trade with using @mention\n` +
        `**Step 2:** Click "Setup Trade" to enter trade details\n` +
        `**Step 3:** Both parties will receive verification amounts to pay\n\n` +
        `Once both are verified, the buyer deposits to escrow.`
      )
      .addFields(
        { name: "Initiator", value: `<@${user.id}>`, inline: true },
        { name: "Trade Partner", value: "Not set yet", inline: true },
        { name: "Status", value: "🆕 Waiting for setup", inline: true }
      )
      .setFooter({ text: `Trade ID: ${shortId}` })
      .setTimestamp();

    const setupButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`setup_trade_${shortId}`)
        .setLabel("Setup Trade")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📝"),
      new ButtonBuilder()
        .setCustomId(`cancel_trade_${shortId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({ content: `<@${user.id}> — Tag the person you want to trade with!`, embeds: [welcomeEmbed], components: [setupButtons] });

    await interaction.editReply({
      content: `Your trade channel has been created! Head to ${channel} to continue.`,
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
          .setLabel("Are you the SELLER or BUYER? (type one)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("seller or buyer")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("sale_amount")
          .setLabel("Sale Amount (e.g., 1000, 2.5k, 50M)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("Enter amount...")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("your_mc")
          .setLabel("Your Minecraft Username")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g., YourName123")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("other_mc")
          .setLabel("Other Party's Minecraft Username")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g., TheirName456")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("notes")
          .setLabel("Item/Service Description (Optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder("What is being traded?")
      )
    );
}

export function createVerificationEmbed(trade, sellerVerified = false, buyerVerified = false) {
  const saleAmount = parseFloat(trade.saleAmount);
  const feeAmount = saleAmount * (FEE_PERCENT / 100);
  const sellerReceives = saleAmount - feeAmount;

  const sellerStatus = sellerVerified ? "✅ Verified" : "❌ Not verified";
  const buyerStatus = buyerVerified ? "✅ Verified" : "❌ Not verified";

  const embed = new EmbedBuilder()
    .setTitle(`🔐 Trade #${trade.id} - Verification Required`)
    .setColor(sellerVerified && buyerVerified ? 0x00FF00 : 0xFFAA00)
    .setDescription(
      `**Both parties must pay their verification amount to ${BOT_MC_USERNAME}**\n\n` +
      `Use the in-game command: \`/pay ${BOT_MC_USERNAME} <amount>\`\n` +
      `The bot will automatically detect your payment.`
    )
    .addFields(
      { name: "💰 Sale Amount", value: formatAmount(saleAmount), inline: true },
      { name: "📊 Fee (5%)", value: formatAmount(feeAmount), inline: true },
      { name: "💵 Seller Receives", value: formatAmount(sellerReceives), inline: true },
      {
        name: `Seller: ${trade.sellerMc}`,
        value: `Pay: **${formatAmount(trade.verificationAmountSeller)}**\nStatus: ${sellerStatus}`,
        inline: true,
      },
      {
        name: `Buyer: ${trade.buyerMc}`,
        value: `Pay: **${formatAmount(trade.verificationAmountBuyer)}**\nStatus: ${buyerStatus}`,
        inline: true,
      }
    )
    .setFooter({ text: `Trade ID: ${trade.id} • Payments to: ${BOT_MC_USERNAME}` })
    .setTimestamp();

  return embed;
}

export function createVerificationButtons(tradeId, sellerVerified, buyerVerified) {
  const bothVerified = sellerVerified && buyerVerified;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`copy_pay_seller_${tradeId}`)
      .setLabel("Copy Seller Pay Command")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📋")
      .setDisabled(sellerVerified),
    new ButtonBuilder()
      .setCustomId(`copy_pay_buyer_${tradeId}`)
      .setLabel("Copy Buyer Pay Command")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📋")
      .setDisabled(buyerVerified)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`deposit_escrow_${tradeId}`)
      .setLabel("Deposit to Escrow")
      .setStyle(ButtonStyle.Success)
      .setEmoji("💰")
      .setDisabled(!bothVerified),
    new ButtonBuilder()
      .setCustomId(`mark_scammed_${tradeId}`)
      .setLabel("Mark as Scammed")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("⚠️"),
    new ButtonBuilder()
      .setCustomId(`cancel_trade_db_${tradeId}`)
      .setLabel("Cancel Trade")
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}

export function createEscrowEmbed(trade) {
  const saleAmount = parseFloat(trade.saleAmount);
  const escrowBalance = parseFloat(trade.escrowBalance) || 0;
  const feeAmount = saleAmount * (FEE_PERCENT / 100);
  const sellerReceives = saleAmount - feeAmount;

  const inEscrow = escrowBalance >= saleAmount;

  const embed = new EmbedBuilder()
    .setTitle(`💼 Trade #${trade.id} - ${inEscrow ? "In Escrow" : "Deposit Required"}`)
    .setColor(inEscrow ? 0x00FF00 : 0xFFAA00)
    .setDescription(
      inEscrow
        ? `**Escrow funded!** Buyer can now confirm delivery when satisfied.`
        : `**Buyer:** Deposit **${formatAmount(saleAmount)}** to ${BOT_MC_USERNAME} to fund escrow.`
    )
    .addFields(
      { name: "Sale Amount", value: formatAmount(saleAmount), inline: true },
      { name: "Escrow Balance", value: formatAmount(escrowBalance), inline: true },
      { name: "Status", value: inEscrow ? "✅ Funded" : "⏳ Awaiting deposit", inline: true },
      { name: "Seller", value: `<@${trade.sellerDiscordId}> (${trade.sellerMc})`, inline: true },
      { name: "Buyer", value: `<@${trade.buyerDiscordId}> (${trade.buyerMc})`, inline: true },
      { name: "Seller Receives", value: formatAmount(sellerReceives), inline: true }
    )
    .setFooter({ text: `Fee: ${FEE_PERCENT}% • Trade ID: ${trade.id}` })
    .setTimestamp();

  return embed;
}

export function createEscrowButtons(tradeId, inEscrow) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_delivered_${tradeId}`)
      .setLabel("Confirm Delivery")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅")
      .setDisabled(!inEscrow),
    new ButtonBuilder()
      .setCustomId(`mark_scammed_${tradeId}`)
      .setLabel("Mark as Scammed")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("⚠️"),
    new ButtonBuilder()
      .setCustomId(`attach_evidence_${tradeId}`)
      .setLabel("Attach Evidence")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📎")
  );
}
