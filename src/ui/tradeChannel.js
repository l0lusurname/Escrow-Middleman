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
      .setTitle("Welcome to Your Trade Channel!")
      .setColor(0x5865F2)
      .setDescription(
        `Hey <@${user.id}>! Let's set up your safe trade.\n\n` +
        `**Step 1:** Tag (@mention) the person you're trading with in this chat\n` +
        `**Step 2:** Click the green **Setup Trade** button below\n\n` +
        `_Example: @username I want to buy your items for 50k_`
      )
      .addFields(
        { name: "Started by", value: `<@${user.id}>`, inline: true },
        { name: "Status", value: "Waiting for partner", inline: true }
      )
      .setFooter({ text: `Trade ID: ${shortId}` })
      .setTimestamp();

    const setupButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`setup_trade_${shortId}`)
        .setLabel("Setup Trade")
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅"),
      new ButtonBuilder()
        .setCustomId(`cancel_trade_${shortId}`)
        .setLabel("Cancel & Close")
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
    .setTitle("Setup Your Trade")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("your_role")
          .setLabel("Your Role (type: seller OR buyer)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("seller or buyer")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("sale_amount")
          .setLabel("Total Price (use k for thousands, m for millions)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("Examples: 5000, 50k, 2.5m, 1b")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("your_mc")
          .setLabel("Your Minecraft Name (exactly as in-game)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("YourMinecraftName")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("other_mc")
          .setLabel("Trading Partner's Minecraft Name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("TheirMinecraftName")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("notes")
          .setLabel("What are you trading? (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder("e.g., Diamond pickaxe, 64 emeralds, rank, etc.")
      )
    );
}

export function createSellerVerificationEmbed(trade) {
  const saleAmount = parseFloat(trade.saleAmount);
  const feeAmount = saleAmount * (FEE_PERCENT / 100);
  const sellerReceives = saleAmount - feeAmount;

  const embed = new EmbedBuilder()
    .setTitle("Seller: Verify Your Identity")
    .setColor(0xFFA500)
    .setDescription(
      `<@${trade.sellerDiscordId}>, please pay a small verification amount to prove you own this Minecraft account.\n\n` +
      `**Go in-game and type this command:**`
    )
    .addFields(
      { name: "Command to Run", value: `\`\`\`/pay ${BOT_MC_USERNAME} ${formatAmount(trade.verificationAmountSeller)}\`\`\``, inline: false },
      { name: "Sale Price", value: formatAmount(saleAmount), inline: true },
      { name: "Our Fee (5%)", value: formatAmount(feeAmount), inline: true },
      { name: "You'll Get", value: `**${formatAmount(sellerReceives)}**`, inline: true }
    )
    .setFooter({ text: `Trade #${trade.id} • This is a small verification payment, not the full trade` })
    .setTimestamp();

  return embed;
}

export function createBuyerVerificationEmbed(trade) {
  const embed = new EmbedBuilder()
    .setTitle("Buyer: Verify Your Identity")
    .setColor(0xFFA500)
    .setDescription(
      `<@${trade.buyerDiscordId}>, please pay a small verification amount to prove you own this Minecraft account.\n\n` +
      `**Go in-game and type this command:**`
    )
    .addFields(
      { name: "Command to Run", value: `\`\`\`/pay ${BOT_MC_USERNAME} ${formatAmount(trade.verificationAmountBuyer)}\`\`\``, inline: false },
      { name: "Trade Total", value: formatAmount(trade.saleAmount), inline: true }
    )
    .setFooter({ text: `Trade #${trade.id} • This is a small verification payment, not the full trade` })
    .setTimestamp();

  return embed;
}

export function createVerificationCompleteEmbed(trade, party) {
  const embed = new EmbedBuilder()
    .setTitle(`${party === 'seller' ? 'Seller' : 'Buyer'} Verified!`)
    .setColor(0x00FF00)
    .setDescription(
      party === 'seller' 
        ? `<@${trade.sellerDiscordId}> is now verified as the seller.`
        : `<@${trade.buyerDiscordId}> is now verified as the buyer.`
    )
    .setFooter({ text: `Trade #${trade.id} • Waiting for both parties to verify` })
    .setTimestamp();

  return embed;
}

export function createEscrowDepositEmbed(trade) {
  const saleAmount = parseFloat(trade.saleAmount);

  const embed = new EmbedBuilder()
    .setTitle("Both Verified! Time to Deposit")
    .setColor(0xFFA500)
    .setDescription(
      `Great news! Both of you are verified.\n\n` +
      `<@${trade.buyerDiscordId}>, now deposit the full payment. We'll hold it safely until the seller delivers.\n\n` +
      `**Go in-game and type:**`
    )
    .addFields(
      { name: "Command to Run", value: `\`\`\`/pay ${BOT_MC_USERNAME} ${formatAmount(saleAmount)}\`\`\``, inline: false },
      { name: "Seller", value: `<@${trade.sellerDiscordId}>`, inline: true },
      { name: "Buyer", value: `<@${trade.buyerDiscordId}>`, inline: true }
    )
    .setFooter({ text: `Trade #${trade.id} • Your money is protected` })
    .setTimestamp();

  return embed;
}

export function createEscrowFundedEmbed(trade) {
  const saleAmount = parseFloat(trade.saleAmount);
  const feeAmount = saleAmount * (FEE_PERCENT / 100);
  const sellerReceives = saleAmount - feeAmount;

  const embed = new EmbedBuilder()
    .setTitle("Payment Received! Money is Safe")
    .setColor(0x00FF00)
    .setDescription(
      `The payment is now held securely by us.\n\n` +
      `**What happens next:**\n` +
      `1. <@${trade.sellerDiscordId}> - Deliver the items/service to the buyer now\n` +
      `2. <@${trade.buyerDiscordId}> - Once you have everything, click **Confirm Delivery**\n` +
      `3. Seller gets paid automatically!\n\n` +
      `_If there's any problem, click Report Issue_`
    )
    .addFields(
      { name: "Held in Escrow", value: `**${formatAmount(saleAmount)}**`, inline: true },
      { name: "Seller Gets", value: formatAmount(sellerReceives), inline: true },
      { name: "Status", value: "Waiting for delivery", inline: true }
    )
    .setFooter({ text: `Trade #${trade.id} • Protected by Escrow` })
    .setTimestamp();

  return embed;
}

export function createEscrowButtons(tradeId, inEscrow) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_delivered_${tradeId}`)
      .setLabel("I Received Everything")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅")
      .setDisabled(!inEscrow),
    new ButtonBuilder()
      .setCustomId(`mark_scammed_${tradeId}`)
      .setLabel("Report Issue")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🚨")
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
    .setTitle("Trade Complete!")
    .setColor(0x00FF00)
    .setDescription(
      `This trade has been completed successfully!\n\n` +
      `<@${trade.sellerDiscordId}>, **${formatAmount(sellerReceives)}** has been sent to you in-game.\n\n` +
      `<@${trade.buyerDiscordId}>, thanks for using our middleman service!\n\n` +
      `_This channel will be archived. You can screenshot this for your records._`
    )
    .addFields(
      { name: "Total Paid", value: formatAmount(trade.saleAmount), inline: true },
      { name: "Service Fee", value: formatAmount(feeAmount), inline: true },
      { name: "Seller Received", value: `**${formatAmount(sellerReceives)}**`, inline: true }
    )
    .setFooter({ text: `Trade #${trade.id} • Completed Successfully` })
    .setTimestamp();

  return embed;
}

export function createDisputeEmbed(trade, reason) {
  const embed = new EmbedBuilder()
    .setTitle("Trade Paused - Staff Notified")
    .setColor(0xFF0000)
    .setDescription(
      `This trade has been paused and staff have been notified.\n\n` +
      `**What happens now:**\n` +
      `• All funds are frozen and safe\n` +
      `• Staff will review the situation\n` +
      `• You may be asked to provide more information\n` +
      `• A decision will be made fairly\n\n` +
      `_Please be patient and provide any evidence you have._`
    )
    .addFields(
      { name: "Trade ID", value: `#${trade.id}`, inline: true },
      { name: "Status", value: "Frozen & Under Review", inline: true },
      { name: "Reported Issue", value: reason || "No details provided" }
    )
    .setFooter({ text: "Staff will resolve this as quickly as possible" })
    .setTimestamp();

  return embed;
}

export function createDisputeButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`adj_seller_${tradeId}`)
      .setLabel("Pay Seller")
      .setStyle(ButtonStyle.Success)
      .setEmoji("💰"),
    new ButtonBuilder()
      .setCustomId(`adj_buyer_${tradeId}`)
      .setLabel("Refund Buyer")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("↩️"),
    new ButtonBuilder()
      .setCustomId(`attach_evidence_${tradeId}`)
      .setLabel("Add Evidence")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📎")
  );
}

export function createVerificationEmbed(trade, sellerVerified = false, buyerVerified = false) {
  const saleAmount = parseFloat(trade.saleAmount);
  const feeAmount = saleAmount * (FEE_PERCENT / 100);
  const sellerReceives = saleAmount - feeAmount;

  const sellerStatus = sellerVerified ? "Verified ✓" : "Waiting...";
  const buyerStatus = buyerVerified ? "Verified ✓" : "Waiting...";

  const embed = new EmbedBuilder()
    .setTitle(`Trade #${trade.id} - Verification Step`)
    .setColor(sellerVerified && buyerVerified ? 0x00FF00 : 0xFFA500)
    .setDescription(
      `**Both of you need to verify your Minecraft accounts.**\n\n` +
      `Go in-game and use \`/pay ${BOT_MC_USERNAME} [amount]\` with your verification amount below.\n` +
      `This proves you own the account and protects against impersonation.`
    )
    .addFields(
      { name: "Trade Total", value: `**${formatAmount(saleAmount)}**`, inline: true },
      { name: "Fee (5%)", value: formatAmount(feeAmount), inline: true },
      { name: "Seller Gets", value: formatAmount(sellerReceives), inline: true },
      {
        name: `Seller: ${trade.sellerMc}`,
        value: `Pay: \`${formatAmount(trade.verificationAmountSeller)}\`\n${sellerStatus}`,
        inline: true,
      },
      {
        name: `Buyer: ${trade.buyerMc}`,
        value: `Pay: \`${formatAmount(trade.verificationAmountBuyer)}\`\n${buyerStatus}`,
        inline: true,
      }
    )
    .setFooter({ text: `Pay these small amounts to: ${BOT_MC_USERNAME}` })
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
    .setTitle(`Trade #${trade.id} - ${inEscrow ? 'Ready for Delivery!' : 'Deposit Step'}`)
    .setColor(inEscrow ? 0x00FF00 : 0xFFA500)
    .setDescription(
      inEscrow
        ? `Payment is secure! Seller, deliver the goods. Buyer, confirm once you have everything.`
        : `**Buyer:** Deposit the full amount to continue.\n\nGo in-game and type:\n\`\`\`/pay ${BOT_MC_USERNAME} ${formatAmount(saleAmount)}\`\`\``
    )
    .addFields(
      { name: "Trade Total", value: `**${formatAmount(saleAmount)}**`, inline: true },
      { name: "In Escrow", value: formatAmount(escrowBalance), inline: true },
      { name: "Status", value: inEscrow ? "Ready for delivery" : "Waiting for deposit", inline: true }
    )
    .setFooter({ text: `Trade #${trade.id} • ${inEscrow ? 'Protected by Escrow' : 'Deposit to proceed'}` })
    .setTimestamp();

  return embed;
}
