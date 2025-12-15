import { db } from "../db/index.js";
import { trades, verifications, botConfig } from "../db/schema.js";
import { eq, and, or } from "drizzle-orm";
import { logAction } from "../utils/auditLog.js";
import { amountsMatch, formatAmount } from "../utils/currencyParser.js";
import { 
  createPaymentReceivedEmbed,
  createProceedWithDealEmbed,
  createReleaseButtons,
  deleteLastBotMessage
} from "../ui/tradeChannel.js";
import { refreshPublicEmbed } from "../ui/publicEmbed.js";

const BOT_MC_USERNAME = process.env.MINECRAFT_USERNAME || "Bunji_MC";

export function createPaymentHandler(discordClient) {
  return async function handlePayment(paymentData) {
    const { payerMc, recipientMc, amount, rawLine, timestamp } = paymentData;

    console.log(`Processing payment: ${payerMc} paid ${amount} to ${recipientMc}`);

    if (recipientMc.toLowerCase() !== BOT_MC_USERNAME.toLowerCase()) {
      console.log(`Payment not to bot (${BOT_MC_USERNAME}), ignoring.`);
      return;
    }

    try {
      const pendingTrades = await db
        .select()
        .from(trades)
        .where(
          and(
            eq(trades.status, "AWAITING_PAYMENT"),
            eq(trades.frozen, false)
          )
        );

      for (const trade of pendingTrades) {
        if (
          trade.sellerMc.toLowerCase() === payerMc.toLowerCase() &&
          amountsMatch(trade.saleAmount, amount)
        ) {
          await handleEscrowDeposit(discordClient, trade, amount, rawLine, timestamp);
          return;
        }
      }

      console.log(`No matching trade found for payment from ${payerMc}`);
    } catch (error) {
      console.error("Error processing payment:", error);
    }
  };
}

async function handleEscrowDeposit(discordClient, trade, amount, rawLine, timestamp) {
  console.log(`Escrow deposit detected for trade #${trade.id}: ${amount}`);

  try {
    await db.insert(verifications).values({
      tradeId: trade.id,
      payerMc: trade.sellerMc,
      recipientMc: BOT_MC_USERNAME,
      expectedAmount: trade.saleAmount,
      receivedAmount: amount.toFixed(2),
      rawLine,
      verified: true,
      timestamp: timestamp || new Date(),
    });

    await db.update(trades).set({
      status: "IN_ESCROW",
      escrowBalance: amount.toFixed(2),
      updatedAt: new Date(),
    }).where(eq(trades.id, trade.id));

    await logAction(trade.id, "BOT", "ESCROW_DEPOSITED", {
      amount,
      rawLine,
    });

    if (trade.threadId) {
      try {
        const channel = await discordClient.channels.fetch(trade.threadId);
        if (channel) {
          await deleteLastBotMessage(channel);

          const updatedTrade = {
            ...trade,
            status: "IN_ESCROW",
            escrowBalance: amount.toFixed(2),
          };

          const paymentEmbed = createPaymentReceivedEmbed(updatedTrade);
          const proceedEmbed = createProceedWithDealEmbed(updatedTrade);
          const releaseButtons = createReleaseButtons(trade.id);

          await channel.send({
            embeds: [paymentEmbed],
          });

          await channel.send({
            content: `<@${trade.sellerDiscordId}> <@${trade.buyerDiscordId}>`,
            embeds: [proceedEmbed],
            components: [releaseButtons],
          });
        }
      } catch (e) {
        console.error("Could not update trade channel:", e);
      }
    }

    const guild = discordClient.guilds.cache.first();
    if (guild) {
      await refreshPublicEmbed(discordClient, guild.id);
    }
  } catch (error) {
    console.error("Error handling escrow deposit:", error);
  }
}
