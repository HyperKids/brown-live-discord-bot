require("dotenv").config();

if (
  !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
  !process.env.GOOGLE_PRIVATE_KEY ||
  !process.env.DISCORDBOTTOKEN ||
  !process.env.GOOGLE_SPREADSHEET
) {
  console.error("Environment variables in .env not defined!");
  process.exit(1);
}

const Discord = require("discord.js");
const client = new Discord.Client({
  intents: [
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMembers,
  ],
});
const fs = require("fs");

const config = JSON.parse(fs.readFileSync("config.json", "utf-8"));
const constants = require("./constants");
const servers = require("./verification.json");

const { GoogleSpreadsheet } = require("google-spreadsheet");
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET);

client.on("ready", async () => {
  // client.user.setActivity("the BEST server!", { type: "WATCHING" });
  console.log(`Logged in as ${client.user?.tag}!`);
  client.guilds.fetch("828708982506913792"); // TODO: don't hardcode this

  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY,
  });
  await doc.loadInfo();

  setInterval(updateVerifiedStudents, 1000 * 60);
});

client.on("message", (msg) => {
  if (!msg.author.bot && msg.type === "DEFAULT") {
    if (msg.content.substring(0, config.prefix.length) === config.prefix) {
      const message = msg.content;
      let args = message.substring(1).split(" ");
      const cmd = args[0];
      args = args.splice(1);

      const isHyper = msg.author.id == "196685652249673728";

      switch (cmd) {
        case "update":
          if (isHyper) {
            constants[args[0]]?.forEach((obj) => {
              msg.channel.send({ content: obj.text, embeds: [obj.embed] });
            });
          }
          break;
      }
    }
  }
});

client.on("guildMemberAdd", (member) => {
  if (member.guild.id === "828708982506913792") {
    client.channels.cache.get("828765547663196191")?.send({
      content: `<@${member.id}>`,
      embeds: [constants.autowelcome.embed],
    });
    member.send({ content: constants.autowelcome.dm });
  }
});

// client.on("messageReactionAdd", (reaction, user) => {
//   reaction.message.react(reaction.emoji)
// })

/**
 * Fetch all guild members using the REST API (paginated).
 * Unlike guild.members.fetch(), this uses GET /guilds/{id}/members
 * and cannot trigger GuildMembersTimeout.
 */
async function fetchAllMembersPaginated(guild) {
  let lastId = '0';
  while (true) {
    const batch = await guild.members.list({ limit: 1000, after: lastId });
    if (batch.size === 0) break;
    lastId = batch.lastKey();
    if (batch.size < 1000) break;
  }
}

async function updateVerifiedStudents() {
  /* Three columns in the Google Sheet:
   * 1. DiscordTag (automatically filled in by Google Form)
   * 2. DiscordTagCache (copy of DiscordTag made by this function)
   * 3. DiscordId (filled in by this function)
   * If DiscordTagCache is different from DiscordTag, then the DiscordId is updated.
   */
  try {
    console.log('[sync] Starting verification sync...');

    // Step 1: Fetch all guild members first to populate client.users.cache
    // This MUST happen before tag resolution, since we search client.users.cache
    for (const server of servers) {
      try {
        const guild = await client.guilds.fetch(server.guildid);
        await fetchAllMembersPaginated(guild);
        console.log(`[sync] Fetched members for ${guild.name} (${guild.members.cache.size} cached)`);
      } catch (err) {
        console.error(`[sync] Failed to fetch members for guild ${server.guildid}:`, err);
      }
    }

    // Step 2: Resolve DiscordTags to DiscordIds using the now-populated cache
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    const updatedRows = rows.filter(
      (row) => row.DiscordTagCache !== row.DiscordTag
    );
    console.log(`[sync] ${updatedRows.length} rows need tag resolution`);

    const rowSavePromises = [];
    for (const row of updatedRows) {
      let user = client.users.cache.find((u) =>
        u.discriminator?.length === 4
          ? `${u.username}#${u.discriminator}` === row.DiscordTag
          : u.username === row.DiscordTag.toLowerCase()
      );
      if (!user) {
        console.log(`[sync] Could not find user for tag: ${row.DiscordTag}`);
        continue;
      }

      console.log(`[sync] Resolved ${row.DiscordTag} -> ${user.id}`);
      row.DiscordId = user.id;
      row.DiscordTagCache = row.DiscordTag;
      rowSavePromises.push(row.save());
    }
    await Promise.all(rowSavePromises);

    // Step 3: Sync verified roles for each guild
    for (const server of servers) {
      try {
        const guild = await client.guilds.fetch(server.guildid);

        const verifiedRole = guild.roles.cache.get(server.verifiedroleid);
        if (!verifiedRole) {
          console.error(
            `[sync] Verified role ${server.verifiedroleid} not found in ${guild.name}!`
          );
          continue;
        }

        const verifiedRoleMembers = verifiedRole.members.map((m) => m.user.id);
        const sheetVerifiedMembers = rows.map((row) => row.DiscordId);
        const posDiff = sheetVerifiedMembers.filter(
          (x) => x && !verifiedRoleMembers.includes(x)
        );
        const negDiff = verifiedRoleMembers.filter(
          (x) => x && !sheetVerifiedMembers.includes(x)
        );

        for (const userId of posDiff) {
          const member = guild.members.cache.get(userId);
          if (member) {
            await member.roles.add(verifiedRole);
            console.log(`[sync] +role ${member.user.username} in ${guild.name}`);
          }
        }
        for (const userId of negDiff) {
          const member = guild.members.cache.get(userId);
          if (member) {
            await member.roles.remove(verifiedRole);
            console.log(`[sync] -role ${member.user.username} in ${guild.name}`);
          }
        }
      } catch (err) {
        console.error(`[sync] Failed to sync roles for guild ${server.guildid}:`, err);
      }
    }

    console.log('[sync] Verification sync complete.');
  } catch (err) {
    console.error('[sync] Failed to update verified students:', err);
  }
}

const http = require("http");
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ok");
});
server.listen(process.env.PORT || 3000);

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});

try {
  client.login(process.env.DISCORDBOTTOKEN).catch((err) => {
    console.error("Failed to login to Discord:", err);
  });
} catch (err) {
  console.error("Failed to login to Discord (synchronous error):", err);
}


