import { SlashCommandBuilder } from "discord.js";
import { db } from "../db/index.js";
import { linkedAccounts } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { generateLinkCode } from "../utils/currencyParser.js";
import { logAction } from "../utils/auditLog.js";

export const data = new SlashCommandBuilder()
  .setName("mm")
  .setDescription("Middleman escrow commands")
  .addSubcommand((sub) =>
    sub
      .setName("link")
      .setDescription("Link your Discord account to your Minecraft username")
      .addStringOption((opt) =>
        opt
          .setName("minecraft_username")
          .setDescription("Your Minecraft username")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Create a new escrow trade")
      .addUserOption((opt) =>
        opt.setName("other_party").setDescription("The other party in the trade").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("seller_mc").setDescription("Seller's Minecraft username").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("buyer_mc").setDescription("Buyer's Minecraft username").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("amount").setDescription("Trade amount (supports k/m/b suffixes)").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("status")
      .setDescription("Check the status of a trade")
      .addIntegerOption((opt) =>
        opt.setName("trade_id").setDescription("The trade ID").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("mark_scammed")
      .setDescription("Report a trade as a scam")
      .addIntegerOption((opt) =>
        opt.setName("trade_id").setDescription("The trade ID").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("reason").setDescription("Reason for reporting").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("adjudicate")
      .setDescription("Admin: Adjudicate a disputed trade")
      .addIntegerOption((opt) =>
        opt.setName("trade_id").setDescription("The trade ID").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("decision")
          .setDescription("Give funds to seller or buyer")
          .setRequired(true)
          .addChoices({ name: "seller", value: "seller" }, { name: "buyer", value: "buyer" })
      )
      .addStringOption((opt) =>
        opt.setName("reason").setDescription("Reason for decision")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("freeze")
      .setDescription("Admin: Freeze a trade")
      .addIntegerOption((opt) =>
        opt.setName("trade_id").setDescription("The trade ID").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("unfreeze")
      .setDescription("Admin: Unfreeze a trade")
      .addIntegerOption((opt) =>
        opt.setName("trade_id").setDescription("The trade ID").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("close_ticket")
      .setDescription("Admin: Close a trade ticket")
      .addIntegerOption((opt) =>
        opt.setName("trade_id").setDescription("The trade ID").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("notes").setDescription("Closing notes")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("setchannel")
      .setDescription("Admin: Set the completion announcements channel")
      .addChannelOption((opt) =>
        opt.setName("channel").setDescription("The channel for announcements").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("set_support_role")
      .setDescription("Admin: Set the support role to tag on scam reports")
      .addRoleOption((opt) =>
        opt.setName("role").setDescription("The support role").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("deposit")
      .setDescription("Mark that escrow deposit has been made")
      .addIntegerOption((opt) =>
        opt.setName("trade_id").setDescription("The trade ID").setRequired(true)
      )
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "link":
      return handleLink(interaction);
    default:
      await interaction.reply({ content: "Command handler not implemented yet.", ephemeral: true });
  }
}

async function handleLink(interaction) {
  const mcUsername = interaction.options.getString("minecraft_username");
  const discordId = interaction.user.id;

  try {
    const existing = await db
      .select()
      .from(linkedAccounts)
      .where(eq(linkedAccounts.discordId, discordId))
      .limit(1);

    if (existing.length > 0 && existing[0].verified) {
      return interaction.reply({
        content: `Your account is already linked to **${existing[0].minecraftUsername}**. Contact staff if you need to change it.`,
        ephemeral: true,
      });
    }

    const code = generateLinkCode();

    if (existing.length > 0) {
      await db
        .update(linkedAccounts)
        .set({
          minecraftUsername: mcUsername,
          verificationCode: code,
          verified: false,
          updatedAt: new Date(),
        })
        .where(eq(linkedAccounts.discordId, discordId));
    } else {
      await db.insert(linkedAccounts).values({
        discordId,
        minecraftUsername: mcUsername,
        verificationCode: code,
        verified: false,
      });
    }

    await logAction(null, discordId, "LINK_INITIATED", { mcUsername, code });

    await interaction.reply({
      content: `To link your account, run this command in-game:\n\`\`\`/mmverify ${code}\`\`\`\nThis code expires in 10 minutes.`,
      ephemeral: true,
    });
  } catch (error) {
    console.error("Link error:", error);
    await interaction.reply({
      content: "An error occurred while linking your account. Please try again.",
      ephemeral: true,
    });
  }
}
