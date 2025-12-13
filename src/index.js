import { Client, GatewayIntentBits, REST, Routes, Events } from "discord.js";
import express from "express";
import { db } from "./db/index.js";
import { data as mmCommand, execute as mmExecute } from "./commands/link.js";
import { handleCreate } from "./commands/handlers/createTrade.js";
import { handleStatus } from "./commands/handlers/tradeStatus.js";
import { handleMarkScammed } from "./commands/handlers/markScammed.js";
import {
  handleAdjudicate,
  handleFreeze,
  handleUnfreeze,
  handleCloseTicket,
  handleSetChannel,
  handleSetSupportRole,
  handleDeposit,
  handleSetMmChannel,
  handlePostEmbed,
  handlePay,
} from "./commands/handlers/adminCommands.js";
import { handleButtonInteraction } from "./events/buttonHandler.js";
import { handleModalSubmit } from "./events/modalHandler.js";
import { createWebhookRouter } from "./webhook/paymentWebhook.js";
import { minecraftBot } from "./minecraft/mineflayer.js";
import { createPaymentHandler } from "./minecraft/paymentHandler.js";
import { getDailyStats, createAdminPanelEmbed } from "./ui/publicEmbed.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const ENABLE_MINEFLAYER = process.env.ENABLE_MINEFLAYER === "true";

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is required. Please set it in your environment variables.");
  process.exit(1);
}

if (!CLIENT_ID) {
  console.error("DISCORD_CLIENT_ID is required. Please set it in your environment variables.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    minecraft: ENABLE_MINEFLAYER ? minecraftBot.isConnected() : "disabled",
  });
});

app.use("/webhook", createWebhookRouter(client));

const PORT = process.env.PORT || 3000;

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: [mmCommand.toJSON()],
    });
    console.log("Slash commands registered successfully.");
  } catch (error) {
    console.error("Error registering commands:", error);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Bot is ready and serving ${readyClient.guilds.cache.size} guild(s)`);

  await registerCommands();

  if (ENABLE_MINEFLAYER) {
    console.log("Mineflayer integration enabled. Connecting to Minecraft...");
    const paymentHandler = createPaymentHandler(client);
    minecraftBot.on("payment", paymentHandler);
    minecraftBot.connect();
  } else {
    console.log("Mineflayer integration disabled. Set ENABLE_MINEFLAYER=true to enable.");
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "mm") {
        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
          case "link":
            await mmExecute(interaction);
            break;
          case "create":
            await handleCreate(interaction);
            break;
          case "status":
            await handleStatus(interaction);
            break;
          case "mark_scammed":
            await handleMarkScammed(interaction);
            break;
          case "adjudicate":
            await handleAdjudicate(interaction);
            break;
          case "freeze":
            await handleFreeze(interaction);
            break;
          case "unfreeze":
            await handleUnfreeze(interaction);
            break;
          case "close_ticket":
            await handleCloseTicket(interaction);
            break;
          case "setchannel":
            await handleSetChannel(interaction);
            break;
          case "set_support_role":
            await handleSetSupportRole(interaction);
            break;
          case "deposit":
            await handleDeposit(interaction);
            break;
          case "set_mm_channel":
            await handleSetMmChannel(interaction);
            break;
          case "post_embed":
            await handlePostEmbed(interaction);
            break;
          case "stats":
            if (!interaction.member.permissions.has("Administrator")) {
              await interaction.reply({ content: "Admin only.", ephemeral: true });
              break;
            }
            await interaction.deferReply({ ephemeral: true });
            const stats = await getDailyStats(interaction.guild.id);
            const statsEmbed = createAdminPanelEmbed(stats);
            await interaction.editReply({ embeds: [statsEmbed] });
            break;
          case "pay":
            await handlePay(interaction);
            break;
          default:
            await interaction.reply({ content: "Unknown subcommand.", ephemeral: true });
        }
      }
    } else if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    }
  } catch (error) {
    console.error("Interaction error:", error);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "An error occurred.", ephemeral: true });
      } else {
        await interaction.reply({ content: "An error occurred.", ephemeral: true });
      }
    } catch (e) {
      console.error("Could not send error response:", e);
    }
  }
});

async function start() {
  try {
    console.log("Starting Donut SMP Escrow Bot...");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Webhook server running on port ${PORT}`);
    });

    console.log("Attempting to login to Discord...");
    await client.login(DISCORD_TOKEN);
    console.log("Discord login completed.");
  } catch (error) {
    console.error("Failed to start:", error);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

start();
