import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { db } from "../../db/index.js";
import { trades, tickets, botConfig } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { formatAmount, parseAmount } from "../../utils/currencyParser.js";
import { logAction } from "../../utils/auditLog.js";
import { postOrUpdatePublicEmbed } from "../../ui/publicEmbed.js";
import { minecraftBot } from "../../minecraft/mineflayer.js";

const OWNER_ID = process.env.OWNER_DISCORD_ID;

function checkAdmin(interaction) {
  return interaction.member.permissions.has(PermissionFlagsBits.Administrator);
}

function checkOwner(interaction) {
  return interaction.user.id === OWNER_ID || interaction.guild.ownerId === interaction.user.id;
}

export async function handleAdjudicate(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const tradeId = interaction.options.getInteger("trade_id");
  const decision = interaction.options.getString("decision");
  const reason = interaction.options.getString("reason") || "No reason provided";

  try {
    await interaction.deferReply();

    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.editReply({ content: `Trade #${tradeId} not found.` });
    }

    if (trade.status === "COMPLETED" || trade.status === "CANCELLED") {
      return interaction.editReply({ content: `Trade is already ${trade.status.toLowerCase()}.` });
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

    await interaction.editReply({ embeds: [embed] });

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
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: "An error occurred during adjudication." });
    } else {
      await interaction.reply({ content: "An error occurred during adjudication.", ephemeral: true });
    }
  }
}

export async function handleFreeze(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const tradeId = interaction.options.getInteger("trade_id");

  try {
    await interaction.deferReply({ ephemeral: true });

    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.editReply({ content: `Trade #${tradeId} not found.` });
    }

    await db.update(trades).set({ frozen: true, updatedAt: new Date() }).where(eq(trades.id, tradeId));
    await logAction(tradeId, interaction.user.id, "FROZEN", {});

    await interaction.editReply({ content: `Trade #${tradeId} has been frozen. Funds cannot be released until unfrozen.` });
  } catch (error) {
    console.error("Freeze error:", error);
    await interaction.editReply({ content: "An error occurred while freezing the trade." });
  }
}

export async function handleUnfreeze(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const tradeId = interaction.options.getInteger("trade_id");

  try {
    await interaction.deferReply({ ephemeral: true });

    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.editReply({ content: `Trade #${tradeId} not found.` });
    }

    await db.update(trades).set({ frozen: false, updatedAt: new Date() }).where(eq(trades.id, tradeId));
    await logAction(tradeId, interaction.user.id, "UNFROZEN", {});

    await interaction.editReply({ content: `Trade #${tradeId} has been unfrozen.` });
  } catch (error) {
    console.error("Unfreeze error:", error);
    await interaction.editReply({ content: "An error occurred while unfreezing the trade." });
  }
}

export async function handleCloseTicket(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const tradeId = interaction.options.getInteger("trade_id");
  const notes = interaction.options.getString("notes") || "Closed by admin";

  try {
    await interaction.deferReply({ ephemeral: true });

    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.editReply({ content: `Trade #${tradeId} not found.` });
    }

    await db.update(tickets).set({
      status: "CLOSED",
      updatedAt: new Date(),
    }).where(eq(tickets.tradeId, tradeId));

    await logAction(tradeId, interaction.user.id, "TICKET_CLOSED", { notes });

    await interaction.editReply({ content: `Ticket for Trade #${tradeId} has been closed. Notes: ${notes}` });
  } catch (error) {
    console.error("Close ticket error:", error);
    await interaction.editReply({ content: "An error occurred while closing the ticket." });
  }
}

export async function handleSetChannel(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const channel = interaction.options.getChannel("channel");
  const guildId = interaction.guild.id;

  try {
    await interaction.deferReply({ ephemeral: true });

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

    await interaction.editReply({ content: `Completion announcements will now be posted in ${channel}.` });
  } catch (error) {
    console.error("Set channel error:", error);
    await interaction.editReply({ content: "An error occurred while setting the channel." });
  }
}

export async function handleSetSupportRole(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const role = interaction.options.getRole("role");
  const guildId = interaction.guild.id;

  try {
    await interaction.deferReply({ ephemeral: true });

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

    await interaction.editReply({ content: `Support role set to ${role}. This role will be tagged on scam reports.` });
  } catch (error) {
    console.error("Set support role error:", error);
    await interaction.editReply({ content: "An error occurred while setting the support role." });
  }
}

export async function handleDeposit(interaction) {
  const tradeId = interaction.options.getInteger("trade_id");

  try {
    await interaction.deferReply({ ephemeral: true });

    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1);

    if (!trade) {
      return interaction.editReply({ content: `Trade #${tradeId} not found.` });
    }

    const userId = interaction.user.id;
    if (trade.buyerDiscordId !== userId && !checkAdmin(interaction)) {
      return interaction.editReply({ content: "Only the buyer or an admin can mark a deposit." });
    }

    if (trade.status !== "VERIFIED") {
      return interaction.editReply({ content: "Trade must be verified before deposit can be made." });
    }

    await db.update(trades).set({
      status: "IN_ESCROW",
      escrowBalance: trade.saleAmount,
      updatedAt: new Date(),
    }).where(eq(trades.id, tradeId));

    await logAction(tradeId, userId, "DEPOSIT_MARKED", { amount: trade.saleAmount });

    await interaction.editReply({ content: `Deposit of ${formatAmount(trade.saleAmount)} marked for Trade #${tradeId}. Trade is now IN_ESCROW.` });
  } catch (error) {
    console.error("Deposit error:", error);
    await interaction.editReply({ content: "An error occurred while marking the deposit." });
  }
}

export async function handleSetMmChannel(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const channel = interaction.options.getChannel("channel");
  const guildId = interaction.guild.id;

  try {
    await interaction.deferReply({ ephemeral: true });

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

    await interaction.editReply({ content: `Public middleman channel set to ${channel}. Use \`/mm post_embed\` to post the Start Middleman button.` });
  } catch (error) {
    console.error("Set MM channel error:", error);
    await interaction.editReply({ content: "An error occurred while setting the channel." });
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

export async function handlePay(interaction) {
  if (!checkOwner(interaction)) {
    return interaction.reply({ content: "Only the bot owner can use this command.", ephemeral: true });
  }

  const ign = interaction.options.getString("ign");
  const amountStr = interaction.options.getString("amount");
  const amount = parseAmount(amountStr);

  if (!amount || amount <= 0) {
    return interaction.reply({ content: "Invalid amount.", ephemeral: true });
  }

  try {
    await interaction.deferReply({ ephemeral: true });

    if (!minecraftBot.isConnected()) {
      return interaction.editReply({ content: "Minecraft bot is not connected." });
    }

    const payCommand = `/pay ${ign} ${amount.toFixed(2)}`;
    minecraftBot.sendChat(payCommand);
    console.log(`Owner payment: ${payCommand}`);

    await logAction(null, interaction.user.id, "OWNER_PAYMENT", { ign, amount });

    await interaction.editReply({ content: `Sent payment command: \`${payCommand}\`` });
  } catch (error) {
    console.error("Pay command error:", error);
    await interaction.editReply({ content: "An error occurred while sending the payment." });
  }
}

export async function handleSetVouchChannel(interaction) {
  if (!checkAdmin(interaction)) {
    return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
  }

  const channel = interaction.options.getChannel("channel");
  const guildId = interaction.guild.id;

  try {
    await interaction.deferReply({ ephemeral: true });

    const [existing] = await db.select().from(botConfig).where(eq(botConfig.guildId, guildId)).limit(1);

    if (existing) {
      await db.update(botConfig).set({
        vouchChannelId: channel.id,
        updatedAt: new Date(),
      }).where(eq(botConfig.guildId, guildId));
    } else {
      await db.insert(botConfig).values({
        guildId,
        vouchChannelId: channel.id,
      });
    }

    await interaction.editReply({ content: `Vouch channel set to ${channel}. Reviews will be posted there after completed trades!` });
  } catch (error) {
    console.error("Set vouch channel error:", error);
    await interaction.editReply({ content: "An error occurred while setting the vouch channel." });
  }
}
