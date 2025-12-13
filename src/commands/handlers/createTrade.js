import { ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { db } from "../../db/index.js";
import { trades, linkedAccounts, tickets, botConfig } from "../../db/schema.js";
import { eq, and, or } from "drizzle-orm";
import { parseAmount, formatAmount, generateVerificationAmount } from "../../utils/currencyParser.js";
import { logAction } from "../../utils/auditLog.js";

export async function handleCreate(interaction) {
  const otherParty = interaction.options.getUser("other_party");
  const sellerMc = interaction.options.getString("seller_mc");
  const buyerMc = interaction.options.getString("buyer_mc");
  const amountStr = interaction.options.getString("amount");

  const saleAmount = parseAmount(amountStr);
  if (!saleAmount || saleAmount <= 0) {
    return interaction.reply({
      content: "Invalid amount. Please use a valid number (supports k/m/b suffixes, e.g., 2.5k, 50M).",
      ephemeral: true,
    });
  }

  const creatorId = interaction.user.id;
  const otherPartyId = otherParty.id;

  if (creatorId === otherPartyId) {
    return interaction.reply({
      content: "You cannot create a trade with yourself.",
      ephemeral: true,
    });
  }

  try {
    const [creatorLink, otherLink] = await Promise.all([
      db.select().from(linkedAccounts).where(and(eq(linkedAccounts.discordId, creatorId), eq(linkedAccounts.verified, true))).limit(1),
      db.select().from(linkedAccounts).where(and(eq(linkedAccounts.discordId, otherPartyId), eq(linkedAccounts.verified, true))).limit(1),
    ]);

    const creatorLinked = creatorLink.length > 0;
    const otherLinked = otherLink.length > 0;

    if (!creatorLinked && !otherLinked) {
      return interaction.reply({
        content: "Neither you nor the other party has a verified Minecraft account linked. Use `/mm link` to link your account first.",
        ephemeral: true,
      });
    }

    const verificationAmountBuyer = generateVerificationAmount();
    const verificationAmountSeller = generateVerificationAmount();

    const isSeller = sellerMc.toLowerCase() === (creatorLink[0]?.minecraftUsername?.toLowerCase() || "");
    const sellerDiscordId = isSeller ? creatorId : otherPartyId;
    const buyerDiscordId = isSeller ? otherPartyId : creatorId;

    await interaction.deferReply();

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
        status: "CREATED",
      })
      .returning();

    const guild = interaction.guild;
    const config = await db.select().from(botConfig).where(eq(botConfig.guildId, guild.id)).limit(1);
    const supportRoleId = config[0]?.supportRoleId;

    const thread = await interaction.channel.threads.create({
      name: `Trade #${newTrade.id} - ${sellerMc} ↔ ${buyerMc}`,
      type: ChannelType.PrivateThread,
      invitable: false,
      reason: `Escrow trade #${newTrade.id}`,
    });

    await thread.members.add(sellerDiscordId);
    await thread.members.add(buyerDiscordId);

    await db.update(trades).set({ threadId: thread.id }).where(eq(trades.id, newTrade.id));

    await db.insert(tickets).values({
      tradeId: newTrade.id,
      threadId: thread.id,
      status: "OPEN",
    });

    const feeAmount = (saleAmount * 0.05).toFixed(2);
    const sellerReceives = (saleAmount - parseFloat(feeAmount)).toFixed(2);

    const embed = new EmbedBuilder()
      .setTitle(`Trade #${newTrade.id} - Escrow Started`)
      .setColor(0x00AE86)
      .addFields(
        { name: "Seller", value: `<@${sellerDiscordId}> (${sellerMc})`, inline: true },
        { name: "Buyer", value: `<@${buyerDiscordId}> (${buyerMc})`, inline: true },
        { name: "Sale Amount", value: formatAmount(saleAmount), inline: true },
        { name: "Fee (5%)", value: formatAmount(feeAmount), inline: true },
        { name: "Seller Receives", value: formatAmount(sellerReceives), inline: true },
        { name: "Status", value: "CREATED - Awaiting Verification", inline: true },
      )
      .setDescription(
        `**Verification Required**\n\n` +
        `To verify this trade, both parties must make small in-game payments:\n\n` +
        `**Buyer** <@${buyerDiscordId}>: Pay exactly **${formatAmount(verificationAmountBuyer)}** to \`${sellerMc}\` in-game\n` +
        `**Seller** <@${sellerDiscordId}>: Pay exactly **${formatAmount(verificationAmountSeller)}** to \`${buyerMc}\` in-game\n\n` +
        `The bot will automatically detect these payments. You have 10 minutes.`
      )
      .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_delivered_${newTrade.id}`)
        .setLabel("Confirm Delivered")
        .setStyle(ButtonStyle.Success)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`mark_scammed_${newTrade.id}`)
        .setLabel("Report Scam")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`request_cancel_${newTrade.id}`)
        .setLabel("Request Cancellation")
        .setStyle(ButtonStyle.Secondary),
    );

    await thread.send({ embeds: [embed], components: [buttons] });

    await logAction(newTrade.id, creatorId, "TRADE_CREATED", {
      sellerDiscordId,
      buyerDiscordId,
      sellerMc,
      buyerMc,
      saleAmount,
      verificationAmountBuyer,
      verificationAmountSeller,
    });

    await interaction.editReply({
      content: `Trade #${newTrade.id} created! Check the private thread: ${thread}`,
    });
  } catch (error) {
    console.error("Create trade error:", error);
    if (interaction.deferred) {
      await interaction.editReply({
        content: "An error occurred while creating the trade. Please try again.",
      });
    } else {
      await interaction.reply({
        content: "An error occurred while creating the trade. Please try again.",
        ephemeral: true,
      });
    }
  }
}
