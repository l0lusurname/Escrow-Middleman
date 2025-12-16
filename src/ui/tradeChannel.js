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
import { formatAmount } from "../utils/currencyParser.js";
import { logAction } from "../utils/auditLog.js";

const BOT_MC_USERNAME = process.env.MINECRAFT_USERNAME || "Bunji_MC";

export async function getGuildFeePercent(guildId) {
  if (!guildId) return 5.0;
  const [config] = await db.select().from(botConfig).where(eq(botConfig.guildId, guildId)).limit(1);
  return parseFloat(config?.feePercent || "5.00");
}

function generateShortId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateTicketNumber() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function formatPayAmount(amount) {
  return parseFloat(amount).toFixed(2);
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
  const ticketNumber = generateTicketNumber();

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
      reason: `Trade ticket for ${user.tag}`,
    });

    const welcomeEmbed = new EmbedBuilder()
      .setColor(0xF5A623)
      .setTitle("Welcome to Donut SMP Middleman")
      .setDescription(
        `Hey <@${user.id}>! Your trade ticket has been created.\n\n` +
        `Your funds will be held securely by our bot until both parties confirm the trade is complete.\n\n` +
        `**Ticket #${ticketNumber}**`
      )
      .setThumbnail("https://i.imgur.com/YQp9mXM.png");

    const securityEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle("Security Notice")
      .setDescription(
        `Our bot and staff will **NEVER** DM you about trades.\n` +
        `Keep all conversations in this ticket to stay safe!`
      );

    const partnerEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle("Who are you trading with?")
      .setDescription(
        `Tag your trading partner below to add them to this ticket.\n\n` +
        `**Example:** \`@username\` or paste their Discord ID`
      );

    const closeButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`close_ticket_${shortId}`)
        .setLabel("Close Ticket")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("🔒")
    );

    await channel.send({ embeds: [welcomeEmbed, securityEmbed], components: [closeButton] });
    await channel.send({ embeds: [partnerEmbed] });

    await interaction.editReply({
      content: `Your trade ticket has been created! Head over to ${channel} to get started.`,
    });

    return channel;
  } catch (error) {
    console.error("Error creating trade channel:", error);
    if (interaction.deferred) {
      await interaction.editReply({ content: "Something went wrong creating your ticket. Please try again!" });
    }
    return null;
  }
}

export function createRoleAssignmentEmbed(trade) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("Select Your Role")
    .setDescription(
      `Both traders need to select their role in this deal.\n\n` +
      `**Who's Who?**\n` +
      `> **Sender** - The person paying Donut SMP money\n` +
      `> **Receiver** - The person receiving Donut SMP money\n\n` +
      `Click the button that matches your role:`
    )
    .setFooter({ text: "Ticket closes automatically after 30 minutes of inactivity" });

  return embed;
}

export function createRoleAssignmentButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`role_sending_${tradeId}`)
      .setLabel("I'm Sending")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("💸"),
    new ButtonBuilder()
      .setCustomId(`role_receiving_${tradeId}`)
      .setLabel("I'm Receiving")
      .setStyle(ButtonStyle.Success)
      .setEmoji("💰"),
    new ButtonBuilder()
      .setCustomId(`role_reset_${tradeId}`)
      .setLabel("Reset")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔄")
  );
}

export function createConfirmRolesEmbed(trade) {
  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle("Confirm These Roles")
    .setDescription(
      `**Please verify this is correct:**\n\n` +
      `> **Sender (Paying):** <@${trade.sellerDiscordId}>\n` +
      `> **Receiver (Getting Paid):** <@${trade.buyerDiscordId}>\n\n` +
      `⚠️ **Selecting the wrong role may result in losing your funds!**`
    );

  return embed;
}

export function createConfirmRolesButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`roles_correct_${tradeId}`)
      .setLabel("Yes, This is Correct")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`roles_incorrect_${tradeId}`)
      .setLabel("No, Change Roles")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("❌")
  );
}

export function createDealAmountEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("Enter Trade Amount")
    .setDescription(
      `**Sender:** Type the amount you're paying in the chat.\n\n` +
      `**Examples:**\n` +
      `> \`100\` for $100\n` +
      `> \`50k\` for $50,000\n` +
      `> \`2.5m\` for $2,500,000\n\n` +
      `Just type the number below!`
    )
    .setFooter({ text: "Ticket closes automatically after 30 minutes of inactivity" });

  return embed;
}

export function createAmountConfirmationEmbed(amount) {
  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle("Confirm Trade Amount")
    .setDescription(
      `**Is this amount correct?**\n\n` +
      `### $${formatPayAmount(amount)}\n\n` +
      `This is the amount that will be held in escrow.`
    );

  return embed;
}

export function createAmountConfirmationButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`amount_confirm_${tradeId}`)
      .setLabel("Confirm Amount")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`amount_incorrect_${tradeId}`)
      .setLabel("Change Amount")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("✏️")
  );
}

export function createDealSummaryEmbed(trade, feePercent = 5.0) {
  const saleAmount = parseFloat(trade.saleAmount);
  const feeAmount = saleAmount * (feePercent / 100);
  const receiverGets = saleAmount - feeAmount;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("Trade Summary")
    .setDescription(`Here's the breakdown of this trade:`)
    .addFields(
      { name: "Sender", value: `<@${trade.sellerDiscordId}>`, inline: true },
      { name: "Receiver", value: `<@${trade.buyerDiscordId}>`, inline: true },
      { name: "Trade Value", value: `**$${formatPayAmount(saleAmount)}**`, inline: true },
      { name: "Service Fee", value: `$${formatPayAmount(feeAmount)} (${feePercent}%)`, inline: true },
      { name: "Receiver Gets", value: `**$${formatPayAmount(receiverGets)}**`, inline: true }
    );

  return embed;
}

export function createPaymentInvoiceEmbed(trade) {
  const saleAmount = parseFloat(trade.saleAmount);

  const embed = new EmbedBuilder()
    .setColor(0xF5A623)
    .setTitle("Payment Required")
    .setDescription(
      `<@${trade.sellerDiscordId}>, send the payment to the middleman bot in-game.\n\n` +
      `**Copy this command and use it in Donut SMP:**`
    )
    .addFields(
      { name: "Command", value: `\`\`\`/pay ${BOT_MC_USERNAME} ${formatPayAmount(saleAmount)}\`\`\`` },
      { name: "Amount", value: `**$${formatPayAmount(saleAmount)}**`, inline: true },
      { name: "Pay To", value: `\`${BOT_MC_USERNAME}\``, inline: true }
    )
    .setFooter({ text: "The bot will automatically detect your payment" });

  return embed;
}

export function createCopyDetailsButton(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`copy_details_${tradeId}`)
      .setLabel("Copy Command")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📋")
  );
}

export function createAwaitingPaymentEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle("Waiting for Payment...")
    .setDescription(
      `The bot is waiting to receive the payment in-game.\n\n` +
      `Once you send the \`/pay\` command in Donut SMP, the bot will automatically confirm it here.`
    );

  return embed;
}

export function createPaymentReceivedEmbed(trade, confirmations = 1) {
  const saleAmount = parseFloat(trade.saleAmount);

  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle("Payment Received!")
    .setDescription(
      `The payment has been received and is now being held securely.`
    )
    .addFields(
      { name: "Trade ID", value: `#${trade.id}`, inline: true },
      { name: "Amount Received", value: `**$${formatPayAmount(saleAmount)}**`, inline: true }
    );

  return embed;
}

export function createProceedWithDealEmbed(trade) {
  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle("Funds Secured - Proceed with Trade")
    .setDescription(
      `<@${trade.sellerDiscordId}> <@${trade.buyerDiscordId}>\n\n` +
      `**The money is now held safely by the middleman bot!**\n\n` +
      `**Receiver** (<@${trade.buyerDiscordId}>): Provide the goods/services now.\n\n` +
      `**Sender** (<@${trade.sellerDiscordId}>): Once you receive what you paid for, click **Release** to send the funds to the receiver.\n\n` +
      `⚠️ Only release funds after you've received everything!`
    );

  return embed;
}

export function createReleaseButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`release_funds_${tradeId}`)
      .setLabel("Release Funds")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`cancel_deal_${tradeId}`)
      .setLabel("Report Issue")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("⚠️")
  );
}

export function createReleaseConfirmationEmbed(trade, feePercent = 5.0) {
  const saleAmount = parseFloat(trade.saleAmount);
  const feeAmount = saleAmount * (feePercent / 100);
  const receiverGets = saleAmount - feeAmount;

  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle("Confirm Fund Release")
    .setDescription(
      `**Are you sure you want to release the funds?**\n\n` +
      `<@${trade.buyerDiscordId}> will receive **$${formatPayAmount(receiverGets)}** in Donut SMP.\n\n` +
      `⚠️ **This action cannot be undone!**\n` +
      `Only confirm if you have received what you paid for.`
    );

  return embed;
}

export function createReleaseConfirmButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_release_${tradeId}`)
      .setLabel("Yes, Release Funds")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`back_release_${tradeId}`)
      .setLabel("Go Back")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("⬅️")
  );
}

export function createSupportNotificationEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setDescription(
      `⚠️ **Staff will NEVER DM you to release funds!**\n` +
      `If someone contacts you claiming to be support, report them immediately.`
    );

  return embed;
}

export function createEscrowButtons(tradeId, inEscrow) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`release_funds_${tradeId}`)
      .setLabel("Release Funds")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅")
      .setDisabled(!inEscrow),
    new ButtonBuilder()
      .setCustomId(`cancel_deal_${tradeId}`)
      .setLabel("Report Issue")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("⚠️")
  );
}

export function createCompletedEmbed(trade, feeAmount, sellerReceives) {
  const embed = new EmbedBuilder()
    .setTitle("Trade Complete!")
    .setColor(0x57F287)
    .setDescription(
      `This trade has been completed successfully!\n\n` +
      `<@${trade.buyerDiscordId}>, **$${formatPayAmount(sellerReceives)}** has been sent to you in Donut SMP!\n\n` +
      `<@${trade.sellerDiscordId}>, thanks for using our middleman service!\n\n` +
      `*Feel free to screenshot this for your records.*`
    )
    .addFields(
      { name: "Total Paid", value: `$${formatPayAmount(trade.saleAmount)}`, inline: true },
      { name: "Service Fee", value: `$${formatPayAmount(feeAmount)}`, inline: true },
      { name: "Receiver Got", value: `**$${formatPayAmount(sellerReceives)}**`, inline: true }
    )
    .setFooter({ text: `Trade #${trade.id} | Donut SMP Middleman` })
    .setTimestamp();

  return embed;
}

export function createDisputeEmbed(trade, reason) {
  const embed = new EmbedBuilder()
    .setTitle("Trade Paused - Staff Notified")
    .setColor(0xED4245)
    .setDescription(
      `This trade has been paused and staff have been notified.\n\n` +
      `**What happens now:**\n` +
      `> All funds are frozen and safe\n` +
      `> Staff will review the situation\n` +
      `> You may be asked for more information\n` +
      `> A fair decision will be made\n\n` +
      `*Please be patient and provide any evidence you have.*`
    )
    .addFields(
      { name: "Trade ID", value: `#${trade.id}`, inline: true },
      { name: "Status", value: "Frozen", inline: true },
      { name: "Reason", value: reason || "No details provided" }
    )
    .setFooter({ text: "Staff will resolve this as quickly as possible" })
    .setTimestamp();

  return embed;
}

export function createDisputeButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`adj_seller_${tradeId}`)
      .setLabel("Return to Sender")
      .setStyle(ButtonStyle.Success)
      .setEmoji("↩️"),
    new ButtonBuilder()
      .setCustomId(`adj_buyer_${tradeId}`)
      .setLabel("Pay Receiver")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("💸"),
    new ButtonBuilder()
      .setCustomId(`attach_evidence_${tradeId}`)
      .setLabel("Add Evidence")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📎")
  );
}

export function createReviewPromptEmbed(trade) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("Leave a Review!")
    .setDescription(
      `Enjoyed using our middleman service? Let others know!\n\n` +
      `Click the button below to leave a quick review. Your feedback helps build trust in our community.`
    )
    .setFooter({ text: "Reviews are posted publicly" });

  return embed;
}

export function createReviewButton(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`leave_review_${tradeId}`)
      .setLabel("Leave a Review")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("⭐")
  );
}

export function createVouchEmbed(trade, reviewerDiscordId, rating, reviewText) {
  const stars = "⭐".repeat(rating) + "☆".repeat(5 - rating);
  const saleAmount = parseFloat(trade.saleAmount);
  
  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle("New Vouch!")
    .setDescription(
      `${stars}\n\n` +
      `"${reviewText}"`
    )
    .addFields(
      { name: "Reviewer", value: `<@${reviewerDiscordId}>`, inline: true },
      { name: "Trade Value", value: `$${saleAmount.toFixed(2)}`, inline: true },
      { name: "Trade ID", value: `#${trade.id}`, inline: true }
    )
    .setFooter({ text: "Donut SMP Middleman | Verified Trade" })
    .setTimestamp();

  return embed;
}
