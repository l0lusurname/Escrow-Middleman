import { db } from "../db/index.js";
import { trades, verifications, botConfig } from "../db/schema.js";
import { eq, and, or } from "drizzle-orm";
import { logAction } from "../utils/auditLog.js";
import { amountsMatch, formatAmount } from "../utils/currencyParser.js";
import { createVerificationEmbed, createVerificationButtons, createEscrowEmbed, createEscrowButtons } from "../ui/tradeChannel.js";
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
            or(
              eq(trades.status, "AWAITING_VERIFICATION"),
              eq(trades.status, "VERIFIED")
            ),
            eq(trades.frozen, false)
          )
        );

      for (const trade of pendingTrades) {
        const isSellerVerification =
          trade.sellerMc.toLowerCase() === payerMc.toLowerCase() &&
          !trade.sellerVerified &&
          amountsMatch(trade.verificationAmountSeller, amount);

        const isBuyerVerification =
          trade.buyerMc.toLowerCase() === payerMc.toLowerCase() &&
          !trade.buyerVerified &&
          amountsMatch(trade.verificationAmountBuyer, amount);

        if (isSellerVerification || isBuyerVerification) {
          await handleVerificationPayment(
            discordClient,
            trade,
            payerMc,
            amount,
            rawLine,
            timestamp,
            isSellerVerification ? "seller" : "buyer"
          );
          return;
        }

        if (
          trade.status === "VERIFIED" &&
          trade.buyerMc.toLowerCase() === payerMc.toLowerCase() &&
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

async function handleVerificationPayment(discordClient, trade, payerMc, amount, rawLine, timestamp, party) {
  console.log(`Verification payment detected for trade #${trade.id} from ${party}: ${payerMc}`);

  try {
    await db.insert(verifications).values({
      tradeId: trade.id,
      payerMc,
      recipientMc: BOT_MC_USERNAME,
      expectedAmount: party === "seller" ? trade.verificationAmountSeller : trade.verificationAmountBuyer,
      receivedAmount: amount.toFixed(2),
      rawLine,
      verified: true,
      timestamp: timestamp || new Date(),
    });

    const updateData = {
      updatedAt: new Date(),
    };

    if (party === "seller") {
      updateData.sellerVerified = true;
    } else {
      updateData.buyerVerified = true;
    }

    const otherPartyVerified = party === "seller" ? trade.buyerVerified : trade.sellerVerified;

    if (otherPartyVerified) {
      updateData.status = "VERIFIED";
    }

    await db.update(trades).set(updateData).where(eq(trades.id, trade.id));

    const updatedTrade = {
      ...trade,
      ...updateData,
    };

    await logAction(trade.id, "BOT", `${party.toUpperCase()}_VERIFIED`, {
      payerMc,
      amount,
      rawLine,
    });

    if (trade.threadId) {
      try {
        const channel = await discordClient.channels.fetch(trade.threadId);
        if (channel) {
          const sellerVerified = party === "seller" ? true : trade.sellerVerified;
          const buyerVerified = party === "buyer" ? true : trade.buyerVerified;

          if (sellerVerified && buyerVerified) {
            const escrowEmbed = createEscrowEmbed({ ...updatedTrade, escrowBalance: "0.00" });
            const escrowButtons = createEscrowButtons(trade.id, false);

            await channel.send({
              content: `Both parties verified! <@${trade.buyerDiscordId}>, please deposit **${formatAmount(trade.saleAmount)}** to escrow.`,
              embeds: [escrowEmbed],
              components: [escrowButtons],
            });
          } else {
            const embed = createVerificationEmbed(updatedTrade, sellerVerified, buyerVerified);
            const buttons = createVerificationButtons(trade.id, sellerVerified, buyerVerified);

            await channel.send({
              content: `${party === "seller" ? "Seller" : "Buyer"} verified! Waiting for ${party === "seller" ? "buyer" : "seller"} to verify.`,
              embeds: [embed],
              components: buttons,
            });
          }
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
    console.error("Error handling verification payment:", error);
  }
}

async function handleEscrowDeposit(discordClient, trade, amount, rawLine, timestamp) {
  console.log(`Escrow deposit detected for trade #${trade.id}: ${amount}`);

  try {
    await db.insert(verifications).values({
      tradeId: trade.id,
      payerMc: trade.buyerMc,
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
          const updatedTrade = {
            ...trade,
            status: "IN_ESCROW",
            escrowBalance: amount.toFixed(2),
          };

          const escrowEmbed = createEscrowEmbed(updatedTrade);
          const escrowButtons = createEscrowButtons(trade.id, true);

          await channel.send({
            content: `Escrow funded! <@${trade.buyerDiscordId}> - confirm delivery when satisfied. <@${trade.sellerDiscordId}> - deliver the goods!`,
            embeds: [escrowEmbed],
            components: [escrowButtons],
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
