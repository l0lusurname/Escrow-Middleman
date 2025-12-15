import { SlashCommandBuilder } from "discord.js";
import { db } from "../db/index.js";
import { linkedAccounts } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { generateLinkCode } from "../utils/currencyParser.js";
import { logAction } from "../utils/auditLog.js";

export const data = new SlashCommandBuilder()
  .setName("mm")
  .setDescription("Safe middleman trading commands")
  .addSubcommand((sub) =>
    sub
      .setName("link")
      .setDescription("Connect your Discord to your Minecraft account")
      .addStringOption((opt) =>
        opt
          .setName("minecraft_username")
          .setDescription("Your exact Minecraft username (case-sensitive)")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Start a new safe trade with someone")
      .addUserOption((opt) =>
        opt.setName("other_party").setDescription("Who are you trading with? @mention them").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("seller_mc").setDescription("Minecraft name of the seller").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("buyer_mc").setDescription("Minecraft name of the buyer").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("amount").setDescription("Price (e.g., 5000, 50k, 2.5m)").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("status")
      .setDescription("Check how your trade is going")
      .addIntegerOption((opt) =>
        opt.setName("trade_id").setDescription("Your trade number (e.g., 123)").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("mark_scammed")
      .setDescription("Report a problem with a trade")
      .addIntegerOption((opt) =>
        opt.setName("trade_id").setDescription("The trade number you're having issues with").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("reason").setDescription("What went wrong? Describe the issue").setRequired(true)
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
  )
  .addSubcommand((sub) =>
    sub
      .setName("set_mm_channel")
      .setDescription("Admin: Set the public middleman channel for the Start Middleman button")
      .addChannelOption((opt) =>
        opt.setName("channel").setDescription("The channel for the public middleman embed").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("post_embed")
      .setDescription("Admin: Post/refresh the public middleman embed in the configured channel")
  )
  .addSubcommand((sub) =>
    sub
      .setName("stats")
      .setDescription("Admin: View daily profit and trade statistics")
  )
  .addSubcommand((sub) =>
    sub
      .setName("set_vouch_channel")
      .setDescription("Admin: Set the channel where trade reviews/vouches are posted")
      .addChannelOption((opt) =>
        opt.setName("channel").setDescription("The channel for vouches and reviews").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("pay")
      .setDescription("Owner: Make the bot pay a player in Minecraft")
      .addStringOption((opt) =>
        opt.setName("ign").setDescription("Minecraft username to pay").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("amount").setDescription("Amount to pay (supports k/m/b suffixes)").setRequired(true)
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
        content: `You're already linked to **${existing[0].minecraftUsername}**!\n\nIf you need to change this, please contact a staff member for help.`,
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
      content: `**Almost there!** Now verify in Minecraft:\n\n` +
        `**Step 1:** Log into the Minecraft server\n` +
        `**Step 2:** Type this command in chat:\n\`\`\`/mmverify ${code}\`\`\`\n` +
        `This code expires in **10 minutes**.\n\n` +
        `_Once verified, you can start trading safely!_`,
      ephemeral: true,
    });
  } catch (error) {
    console.error("Link error:", error);
    await interaction.reply({
      content: "Something went wrong while setting up your link. Please try again in a moment, or contact staff if it keeps happening.",
      ephemeral: true,
    });
  }
}
