import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { db } from "../../db/index.js";
import { trades, tickets, botConfig } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { formatAmount } from "../../utils/currencyParser.js";
import { logAction } from "../../utils/auditLog.js";
import { postOrUpdatePublicEmbed } from "../../ui/publicEmbed.js";

function checkAdmin(interaction) {
  return interaction.member.permissions.has(PermissionFlagsBits.Administrator);
}

export async function handleAdjudicate(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const tradeId = interaction.options.getInteger("trade_id");
  const decision = interaction.options.getString("decision");
  const reason = interaction.options.getString("reason") || "No reason provided";

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: `Trade #${tradeId} not found.`, ephemeral: true });
    }

    if (trade.status === "COMPLETED" || trade.status === "CANCELLED") {
      return interaction.reply({ content: `Trade is already ${trade.status.toLowerCase()}.`, ephemeral: true });
    }

    const escrowBalance = parseFloat(trade.escrowBalance || 0);
    const saleAmount = parseFloat(trade.saleAmount);
    const feeAmount = saleAmount * 0.05;

    let recipientId, recipientMc, amountReleased;

    if (decision === "seller") {
      recipientId = trade.sellerDiscordId;
      recipientMc = trade.sellerMc;
      amountReleased = escrowBalance > 0 ? escrowBalance - feeAmount : saleAmount - feeAmount;
    } else {
      recipientId = trade.buyerDiscordId;
      recipientMc = trade.buyerMc;
      amountReleased = escrowBalance > 0 ? escrowBalance : saleAmount;
    }

    await db.update(trades).set({
      status: "COMPLETED",
      frozen: false,
      feeAmount: decision === "seller" ? feeAmount.toFixed(2) : "0.00",
      updatedAt: new Date(),
    }).where(eq(trades.id, tradeId));

    await db.update(tickets).set({
      status: "CLOSED",
      updatedAt: new Date(),
    }).where(eq(tickets.tradeId, tradeId));

    await logAction(tradeId, interaction.user.id, "ADJUDICATED", { decision, reason, amountReleased });

    const embed = new EmbedBuilder()
      .setTitle(`Trade #${tradeId} Adjudicated`)
      .setColor(0x00FF00)
      .addFields(
        { name: "Decision", value: `Funds released to ${decision}`, inline: true },
        { name: "Recipient", value: `<@${recipientId}> (${recipientMc})`, inline: true },
        { name: "Amount Released", value: formatAmount(amountReleased), inline: true },
        { name: "Reason", value: reason },
        { name: "Adjudicator", value: `<@${interaction.user.id}>` },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    const guild = interaction.guild;
    const [config] = await db.select().from(botConfig).where(eq(botConfig.guildId, guild.id)).limit(1);

    if (config?.completionChannelId) {
      try {
        const channel = await guild.channels.fetch(config.completionChannelId);
        if (channel) {
          await channel.send({
            content: `Trade #${tradeId} has been adjudicated. Funds released to <@${recipientId}>.`,
            embeds: [embed],
          });
        }
      } catch (e) {
        console.error("Could not post to completion channel:", e);
      }
    }
  } catch (error) {
    console.error("Adjudicate error:", error);
    await interaction.reply({ content: "An error occurred during adjudication.", ephemeral: true });
  }
}

export async function handleFreeze(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const tradeId = interaction.options.getInteger("trade_id");

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: `Trade #${tradeId} not found.`, ephemeral: true });
    }

    await db.update(trades).set({ frozen: true, updatedAt: new Date() }).where(eq(trades.id, tradeId));
    await logAction(tradeId, interaction.user.id, "FROZEN", {});

    await interaction.reply({ content: `Trade #${tradeId} has been frozen. Funds cannot be released until unfrozen.` });
  } catch (error) {
    console.error("Freeze error:", error);
    await interaction.reply({ content: "An error occurred while freezing the trade.", ephemeral: true });
  }
}

export async function handleUnfreeze(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const tradeId = interaction.options.getInteger("trade_id");

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: `Trade #${tradeId} not found.`, ephemeral: true });
    }

    await db.update(trades).set({ frozen: false, updatedAt: new Date() }).where(eq(trades.id, tradeId));
    await logAction(tradeId, interaction.user.id, "UNFROZEN", {});

    await interaction.reply({ content: `Trade #${tradeId} has been unfrozen.` });
  } catch (error) {
    console.error("Unfreeze error:", error);
    await interaction.reply({ content: "An error occurred while unfreezing the trade.", ephemeral: true });
  }
}

export async function handleCloseTicket(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const tradeId = interaction.options.getInteger("trade_id");
  const notes = interaction.options.getString("notes") || "Closed by admin";

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: `Trade #${tradeId} not found.`, ephemeral: true });
    }

    await db.update(tickets).set({
      status: "CLOSED",
      updatedAt: new Date(),
    }).where(eq(tickets.tradeId, tradeId));

    await logAction(tradeId, interaction.user.id, "TICKET_CLOSED", { notes });

    await interaction.reply({ content: `Ticket for Trade #${tradeId} has been closed. Notes: ${notes}` });
  } catch (error) {
    console.error("Close ticket error:", error);
    await interaction.reply({ content: "An error occurred while closing the ticket.", ephemeral: true });
  }
}

export async function handleSetChannel(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const channel = interaction.options.getChannel("channel");
  const guildId = interaction.guild.id;

  try {
    const [existing] = await db.select().from(botConfig).where(eq(botConfig.guildId, guildId)).limit(1);

    if (existing) {
      await db.update(botConfig).set({
        completionChannelId: channel.id,
        updatedAt: new Date(),
      }).where(eq(botConfig.guildId, guildId));
    } else {
      await db.insert(botConfig).values({
        guildId,
        completionChannelId: channel.id,
      });
    }

    await interaction.reply({ content: `Completion announcements will now be posted in ${channel}.` });
  } catch (error) {
    console.error("Set channel error:", error);
    await interaction.reply({ content: "An error occurred while setting the channel.", ephemeral: true });
  }
}

export async function handleSetSupportRole(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const role = interaction.options.getRole("role");
  const guildId = interaction.guild.id;

  try {
    const [existing] = await db.select().from(botConfig).where(eq(botConfig.guildId, guildId)).limit(1);

    if (existing) {
      await db.update(botConfig).set({
        supportRoleId: role.id,
        updatedAt: new Date(),
      }).where(eq(botConfig.guildId, guildId));
    } else {
      await db.insert(botConfig).values({
        guildId,
        supportRoleId: role.id,
      });
    }

    await interaction.reply({ content: `Support role set to ${role}. This role will be tagged on scam reports.` });
  } catch (error) {
    console.error("Set support role error:", error);
    await interaction.reply({ content: "An error occurred while setting the support role.", ephemeral: true });
  }
}

export async function handleDeposit(interaction) {
  const tradeId = interaction.options.getInteger("trade_id");

  try {
    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.reply({ content: `Trade #${tradeId} not found.`, ephemeral: true });
    }

    const userId = interaction.user.id;
    if (trade.buyerDiscordId !== userId && !checkAdmin(interaction)) {
      return interaction.reply({ content: "Only the buyer or an admin can mark a deposit.", ephemeral: true });
    }

    if (trade.status !== "VERIFIED") {
      return interaction.reply({ content: "Trade must be verified before deposit can be made.", ephemeral: true });
    }

    await db.update(trades).set({
      status: "IN_ESCROW",
      escrowBalance: trade.saleAmount,
      updatedAt: new Date(),
    }).where(eq(trades.id, tradeId));

    await logAction(tradeId, userId, "DEPOSIT_MARKED", { amount: trade.saleAmount });

    await interaction.reply({ content: `Deposit of ${formatAmount(trade.saleAmount)} marked for Trade #${tradeId}. Trade is now IN_ESCROW.` });
  } catch (error) {
    console.error("Deposit error:", error);
    await interaction.reply({ content: "An error occurred while marking the deposit.", ephemeral: true });
  }
}

export async function handleSetMmChannel(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const channel = interaction.options.getChannel("channel");
  const guildId = interaction.guild.id;

  try {
    const [existing] = await db.select().from(botConfig).where(eq(botConfig.guildId, guildId)).limit(1);

    if (existing) {
      await db.update(botConfig).set({
        publicMiddlemanChannelId: channel.id,
        updatedAt: new Date(),
      }).where(eq(botConfig.guildId, guildId));
    } else {
      await db.insert(botConfig).values({
        guildId,
        publicMiddlemanChannelId: channel.id,
      });
    }

    await interaction.reply({ content: `Public middleman channel set to ${channel}. Use \`/mm post_embed\` to post the Start Middleman button.` });
  } catch (error) {
    console.error("Set MM channel error:", error);
    await interaction.reply({ content: "An error occurred while setting the channel.", ephemeral: true });
  }
}

export async function handlePostEmbed(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const guildId = interaction.guild.id;

  try {
    await interaction.deferReply({ ephemeral: true });

    const message = await postOrUpdatePublicEmbed(interaction.client, guildId);

    if (message) {
      await interaction.editReply({ content: `Public middleman embed posted/updated successfully!` });
    } else {
      await interaction.editReply({ content: `Failed to post embed. Make sure you've set the middleman channel with \`/mm set_mm_channel\` first.` });
    }
  } catch (error) {
    console.error("Post embed error:", error);
    await interaction.editReply({ content: "An error occurred while posting the embed." });
  }
}
