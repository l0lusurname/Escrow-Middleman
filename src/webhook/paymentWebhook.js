import express from "express";
import { db } from "../db/index.js";
import { trades, verifications, linkedAccounts, botConfig } from "../db/schema.js";
import { eq, and, or } from "drizzle-orm";
import { verifyHmacDetailed } from "../utils/hmac.js";
import { parseAmount, formatAmount, amountsMatch } from "../utils/currencyParser.js";
import { logAction } from "../utils/auditLog.js";

const router = express.Router();

const PAYMENT_REGEX = /(?<recipient>\w+) paid you \$?(?<amount>[0-9.,]+(?:[kKmMbB])?)/i;

export function createWebhookRouter(discordClient) {
  router.post("/payment", express.json(), async (req, res) => {
    try {
      const signature = req.headers["x-hmac-signature"];
      const guildId = req.headers["x-guild-id"];

      if (!signature || !guildId) {
        return res.status(401).json({ error: "Missing authentication headers" });
      }

      const [config] = await db.select().from(botConfig).where(eq(botConfig.guildId, guildId)).limit(1);

      if (!config?.webhookSecret) {
        return res.status(401).json({ error: "Webhook secret not configured for this guild" });
      }

      try {
        const payload = req.rawBody || (req.body ? JSON.stringify(req.body) : '')
        const result = verifyHmacDetailed(payload, signature, config.webhookSecret)
        if (!result.ok) {
          const mask = s => s ? `${s.slice(0,6)}...${s.slice(-6)} (len=${s.length})` : '<none>'
          console.warn(`⚠️ Webhook signature verification failed. Provided: ${mask(signature)}; Expected(hex): ${mask(result.expectedHex)}; reason: ${result.reason}`)
          return res.status(401).json({ error: "Invalid signature" });
        }
      } catch (e) {
        return res.status(401).json({ error: "Signature verification failed" });
      }

      const { chatLine, payerMc, timestamp } = req.body;

      if (!chatLine) {
        return res.status(400).json({ error: "Missing chatLine" });
      }

      const match = chatLine.match(PAYMENT_REGEX);

      if (!match) {
        return res.status(200).json({ message: "No payment detected in chat line" });
      }

      const recipientMc = match.groups.recipient;
      const rawAmount = match.groups.amount;
      const amount = parseAmount(rawAmount);

      if (!amount) {
        return res.status(200).json({ message: "Could not parse payment amount" });
      }

      const actualPayerMc = payerMc;

      await logAction(null, "webhook", "PAYMENT_RECEIVED", { 
        chatLine, 
        payerMc: actualPayerMc, 
        recipientMc, 
        amount 
      }, "system");

      const pendingTrades = await db
        .select()
        .from(trades)
        .where(
          and(
            or(eq(trades.status, "CREATED"), eq(trades.status, "PARTIAL_VERIFIED")),
            or(
              and(eq(trades.buyerMc, actualPayerMc), eq(trades.sellerMc, recipientMc)),
              and(eq(trades.sellerMc, actualPayerMc), eq(trades.buyerMc, recipientMc))
            )
          )
        );

      for (const trade of pendingTrades) {
        const isBuyerPaying = trade.buyerMc.toLowerCase() === actualPayerMc.toLowerCase();
        const isSellerPaying = trade.sellerMc.toLowerCase() === actualPayerMc.toLowerCase();

        let expectedAmount, verified = false, role = "";

        if (isBuyerPaying && !trade.buyerVerified) {
          expectedAmount = parseFloat(trade.verificationAmountBuyer);
          if (amountsMatch(expectedAmount, amount)) {
            await db.update(trades).set({ 
              buyerVerified: true, 
              updatedAt: new Date() 
            }).where(eq(trades.id, trade.id));
            verified = true;
            role = "buyer";
          }
        } else if (isSellerPaying && !trade.sellerVerified) {
          expectedAmount = parseFloat(trade.verificationAmountSeller);
          if (amountsMatch(expectedAmount, amount)) {
            await db.update(trades).set({ 
              sellerVerified: true, 
              updatedAt: new Date() 
            }).where(eq(trades.id, trade.id));
            verified = true;
            role = "seller";
          }
        }

        if (verified) {
          await db.insert(verifications).values({
            tradeId: trade.id,
            payerMc: actualPayerMc,
            recipientMc,
            expectedAmount: expectedAmount.toFixed(2),
            receivedAmount: amount.toFixed(2),
            rawLine: chatLine,
            verified: true,
          });

          await logAction(trade.id, "webhook", "VERIFICATION_MATCHED", { 
            role, 
            amount, 
            expectedAmount 
          }, "system");

          const [updatedTrade] = await db.select().from(trades).where(eq(trades.id, trade.id)).limit(1);

          if (trade.threadId && discordClient) {
            try {
              const guild = discordClient.guilds.cache.find(g => g.id);
              if (guild) {
                const thread = await guild.channels.fetch(trade.threadId);
                if (thread) {
                  await thread.send(
                    `Verification payment detected: **${actualPayerMc}** → **${recipientMc}** ${formatAmount(amount)} (verified)`
                  );

                  if (updatedTrade.buyerVerified && updatedTrade.sellerVerified) {
                    await db.update(trades).set({ 
                      status: "VERIFIED", 
                      updatedAt: new Date() 
                    }).where(eq(trades.id, trade.id));

                    await thread.send(
                      `Both parties verified! Trade #${trade.id} is now **VERIFIED**.\n\n` +
                      `**Buyer** <@${trade.buyerDiscordId}>: Please deposit ${formatAmount(trade.saleAmount)} into escrow.\n` +
                      `Use \`/mm deposit ${trade.id}\` after making the deposit.`
                    );

                    await logAction(trade.id, "system", "TRADE_VERIFIED", {}, "system");
                  }
                }
              }
            } catch (e) {
              console.error("Could not post to trade thread:", e);
            }
          }
        }
      }

      res.json({ success: true, message: "Payment processed" });
    } catch (error) {
      console.error("Webhook error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/verify-account", express.json(), async (req, res) => {
    try {
      const signature = req.headers["x-hmac-signature"];
      const guildId = req.headers["x-guild-id"];

      if (!signature || !guildId) {
        return res.status(401).json({ error: "Missing authentication headers" });
      }

      const [config] = await db.select().from(botConfig).where(eq(botConfig.guildId, guildId)).limit(1);

      if (!config?.webhookSecret) {
        return res.status(401).json({ error: "Webhook secret not configured" });
      }

      try {
        const payload = req.rawBody || (req.body ? JSON.stringify(req.body) : '')
        const result = verifyHmacDetailed(payload, signature, config.webhookSecret)
        if (!result.ok) {
          const mask = s => s ? `${s.slice(0,6)}...${s.slice(-6)} (len=${s.length})` : '<none>'
          console.warn(`⚠️ Webhook signature verification failed. Provided: ${mask(signature)}; Expected(hex): ${mask(result.expectedHex)}; reason: ${result.reason}`)
          return res.status(401).json({ error: "Invalid signature" });
        }
      } catch (e) {
        return res.status(401).json({ error: "Signature verification failed" });
      }

      const { minecraftUsername, verificationCode } = req.body;

      if (!minecraftUsername || !verificationCode) {
        return res.status(400).json({ error: "Missing minecraftUsername or verificationCode" });
      }

      const [account] = await db
        .select()
        .from(linkedAccounts)
        .where(
          and(
            eq(linkedAccounts.verificationCode, verificationCode),
            eq(linkedAccounts.verified, false)
          )
        )
        .limit(1);

      if (!account) {
        return res.status(404).json({ error: "Invalid or expired verification code" });
      }

      if (account.minecraftUsername.toLowerCase() !== minecraftUsername.toLowerCase()) {
        return res.status(400).json({ error: "Minecraft username does not match" });
      }

      await db.update(linkedAccounts).set({
        verified: true,
        verificationCode: null,
        minecraftUsername: minecraftUsername,
        updatedAt: new Date(),
      }).where(eq(linkedAccounts.id, account.id));

      await logAction(null, account.discordId, "ACCOUNT_VERIFIED", { minecraftUsername });

      res.json({ success: true, discordId: account.discordId, minecraftUsername });
    } catch (error) {
      console.error("Verify account error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

export default router;
