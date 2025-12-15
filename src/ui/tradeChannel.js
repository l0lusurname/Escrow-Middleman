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
const FEE_PERCENT = parseFloat(process.env.FEE_PERCENT) || 5.0;

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
      name: `ticket-${shortId}`,
      type: ChannelType.GuildText,
      permissionOverwrites: overwrites,
      reason: `Middleman ticket for ${user.tag}`,
    });

    const welcomeEmbed = new EmbedBuilder()
      .setColor(0x2F3136)
      .setTitle("Cryptocurrency Middleman System")
      .setDescription(
        `Middleman request created successfully!\n\n` +
        `Welcome to our automated cryptocurrency Middleman system!\n` +
        `Your cryptocurrency will be stored securely for the duration of this deal. Please notify support for assistance.\n\n` +
        `**Ticket #${ticketNumber}**`
      );

    const securityEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle("Security Notification")
      .setDescription(
        `Our bot and staff team will **NEVER** direct message you. Ensure all conversations related to the deal are done within this ticket. Failure to do so may put you at risk of being scammed.`
      );

    const partnerEmbed = new EmbedBuilder()
      .setColor(0x2F3136)
      .setTitle("Who are you dealing with?")
      .setDescription(
        `eg. @user\neg. 1234567891234567889`
      );

    const closeButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`close_ticket_${shortId}`)
        .setLabel("Close")
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({ embeds: [welcomeEmbed, securityEmbed], components: [closeButton] });
    await channel.send({ embeds: [partnerEmbed] });

    await interaction.editReply({
      content: `Your ticket has been created: ${channel}`,
    });

    return channel;
  } catch (error) {
    console.error("Error creating trade channel:", error);
    if (interaction.deferred) {
      await interaction.editReply({ content: "Failed to create ticket. Please try again." });
    }
    return null;
  }
}

export function createRoleAssignmentEmbed(trade) {
  const embed = new EmbedBuilder()
    .setColor(0x2F3136)
    .setTitle("Role Assignment")
    .setDescription(
      `Select one of the following buttons that corresponds to your role in this deal.\n` +
      `Once selected, both users must confirm to proceed.\n\n` +
      `**Sending Payment**\t\t**Receiving Payment**\n` +
      `<@${trade.sellerDiscordId}>\t\t<@${trade.buyerDiscordId}>\n\n` +
      `_Ticket will be closed in 30 minutes if left unattended_`
    );

  return embed;
}

export function createRoleAssignmentButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`role_sending_${tradeId}`)
      .setLabel("Sending")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`role_receiving_${tradeId}`)
      .setLabel("Receiving")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`role_reset_${tradeId}`)
      .setLabel("Reset")
      .setStyle(ButtonStyle.Danger)
  );
}

export function createConfirmRolesEmbed(trade) {
  const embed = new EmbedBuilder()
    .setColor(0x2F3136)
    .setTitle("Confirm Roles")
    .setDescription(
      `**Sender**\t\t\t**Receiver**\n` +
      `<@${trade.sellerDiscordId}>\t\t<@${trade.buyerDiscordId}>\n\n` +
      `_Selecting the wrong role will result in getting scammed_`
    );

  return embed;
}

export function createConfirmRolesButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`roles_correct_${tradeId}`)
      .setLabel("Correct")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`roles_incorrect_${tradeId}`)
      .setLabel("Incorrect")
      .setStyle(ButtonStyle.Secondary)
  );
}

export function createDealAmountEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x2F3136)
    .setTitle("Deal Amount")
    .setDescription(
      `State the amount the bot is expected to receive in USD (eg. 100.59)\n\n` +
      `_Ticket will be closed in 30 minutes if left unattended_`
    );

  return embed;
}

export function createAmountConfirmationEmbed(amount) {
  const embed = new EmbedBuilder()
    .setColor(0x2F3136)
    .setTitle("Amount Confirmation")
    .setDescription(
      `Confirm that the bot will receive the following USD value\n\n` +
      `**Amount**\n` +
      `$${formatPayAmount(amount)}`
    );

  return embed;
}

export function createAmountConfirmationButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`amount_confirm_${tradeId}`)
      .setLabel("\u200b\u200b\u200b")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`amount_incorrect_${tradeId}`)
      .setLabel("Incorrect")
      .setStyle(ButtonStyle.Secondary)
  );
}

export function createDealSummaryEmbed(trade) {
  const saleAmount = parseFloat(trade.saleAmount);

  const embed = new EmbedBuilder()
    .setColor(0x2F3136)
    .setTitle("Deal Summary")
    .setDescription(
      `Refer to this deal summary for any reaffirmations. Notify staff for any support required.\n\n` +
      `**Sender**\t\t\t**Receiver**\t\t\t**Deal Value**\n` +
      `<@${trade.sellerDiscordId}>\t\t<@${trade.buyerDiscordId}>\t\t$${formatPayAmount(saleAmount)}`
    );

  return embed;
}

export function createPaymentInvoiceEmbed(trade) {
  const saleAmount = parseFloat(trade.saleAmount);

  const embed = new EmbedBuilder()
    .setColor(0x2F3136)
    .setTitle("Payment Invoice")
    .setDescription(
      `<@${trade.sellerDiscordId}> Send the funds as part of the deal to the Middleman. Please copy the command below.\n\n` +
      `**Command**\n` +
      `\`\`\`/pay ${BOT_MC_USERNAME} ${formatPayAmount(saleAmount)}\`\`\`\n` +
      `**Amount**\n` +
      `${formatPayAmount(saleAmount)}`
    );

  return embed;
}

export function createCopyDetailsButton(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`copy_details_${tradeId}`)
      .setLabel("Copy Details")
      .setStyle(ButtonStyle.Secondary)
  );
}

export function createAwaitingPaymentEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x2F3136)
    .setDescription(`Awaiting transaction...`);

  return embed;
}

export function createPaymentReceivedEmbed(trade, confirmations = 1) {
  const saleAmount = parseFloat(trade.saleAmount);

  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle("Payment Received")
    .setDescription(
      `The payment is now secured, and has reached the required amount of confirmations.\n\n` +
      `**Transaction**\n` +
      `Trade #${trade.id}\n\n` +
      `**Confirmations**\t\t**Amount Received**\n` +
      `${confirmations}\t\t\t\t${formatPayAmount(saleAmount)}`
    );

  return embed;
}

export function createProceedWithDealEmbed(trade) {
  const embed = new EmbedBuilder()
    .setColor(0x2F3136)
    .setDescription(
      `<@${trade.sellerDiscordId}> <@${trade.buyerDiscordId}>\n\n` +
      `**You may now proceed with the deal**\n\n` +
      `The receiver (<@${trade.buyerDiscordId}>) may now provide the goods to the sender (<@${trade.sellerDiscordId}>).\n\n` +
      `Once the deal is complete, the sender must click the 'Release' button below to release the funds to the receiver & complete the deal.`
    );

  return embed;
}

export function createReleaseButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`release_funds_${tradeId}`)
      .setLabel("Release")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`cancel_deal_${tradeId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

export function createReleaseConfirmationEmbed(trade) {
  const embed = new EmbedBuilder()
    .setColor(0x2F3136)
    .setTitle("Release Confirmation")
    .setDescription(
      `Are you sure you would like to release the funds to receiver, <@${trade.buyerDiscordId}>?\n\n` +
      `Once this is confirmed, the funds will be released, and the deal will be marked as complete.\n\n` +
      `**Staff will never DM you to release**`
    );

  return embed;
}

export function createReleaseConfirmButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_release_${tradeId}`)
      .setLabel("Confirm (2)")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`back_release_${tradeId}`)
      .setLabel("Back")
      .setStyle(ButtonStyle.Secondary)
  );
}

export function createSupportNotificationEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x2F3136)
    .setDescription(
      `Support won't DM/notify you to release. If someone is contacting you, please notify @Support`
    );

  return embed;
}

export function createEscrowButtons(tradeId, inEscrow) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`release_funds_${tradeId}`)
      .setLabel("Release")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!inEscrow),
    new ButtonBuilder()
      .setCustomId(`cancel_deal_${tradeId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

export function createCompletedEmbed(trade, feeAmount, sellerReceives) {
  const embed = new EmbedBuilder()
    .setTitle("Deal Complete!")
    .setColor(0x00FF00)
    .setDescription(
      `This deal has been completed successfully!\n\n` +
      `<@${trade.buyerDiscordId}>, **${formatPayAmount(sellerReceives)}** has been sent to you in-game.\n\n` +
      `<@${trade.sellerDiscordId}>, thanks for using our middleman service!\n\n` +
      `_This channel will be archived. You can screenshot this for your records._`
    )
    .addFields(
      { name: "Total Paid", value: formatPayAmount(trade.saleAmount), inline: true },
      { name: "Service Fee", value: formatPayAmount(feeAmount), inline: true },
      { name: "Receiver Got", value: `**${formatPayAmount(sellerReceives)}**`, inline: true }
    )
    .setFooter({ text: `Trade #${trade.id} - Completed Successfully` })
    .setTimestamp();

  return embed;
}

export function createDisputeEmbed(trade, reason) {
  const embed = new EmbedBuilder()
    .setTitle("Deal Paused - Staff Notified")
    .setColor(0xFF0000)
    .setDescription(
      `This deal has been paused and staff have been notified.\n\n` +
      `**What happens now:**\n` +
      `- All funds are frozen and safe\n` +
      `- Staff will review the situation\n` +
      `- You may be asked to provide more information\n` +
      `- A decision will be made fairly\n\n` +
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
      .setLabel("Pay Sender")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`adj_buyer_${tradeId}`)
      .setLabel("Pay Receiver")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`attach_evidence_${tradeId}`)
      .setLabel("Add Evidence")
      .setStyle(ButtonStyle.Secondary)
  );
}
