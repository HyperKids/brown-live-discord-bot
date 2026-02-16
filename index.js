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

// In-memory backoff for failed tag lookups
const failedTagLookups = new Map();
const RETRY_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// Set of unresolved tags (lowercase), refreshed each polling cycle
const unresolvedTags = new Set();

// Daily stats — accumulates throughout the day, logged once at midnight
let dailyStats = {
  tagsResolved: 0,
  legacyTagsSkipped: 0,
  tagsNotFound: 0,
  rolesAdded: 0,
  rolesRemoved: 0,
  eventResolutions: 0,
  errors: 0,
  syncCycles: 0,
};

function logDailySummary() {
  const s = dailyStats;
  console.log(
    `[daily] Sync cycles: ${s.syncCycles} | Resolved: ${s.tagsResolved} | ` +
    `Legacy skipped: ${s.legacyTagsSkipped} | Not found: ${s.tagsNotFound} | ` +
    `Roles +${s.rolesAdded}/-${s.rolesRemoved} | ` +
    `Event resolutions: ${s.eventResolutions} | Errors: ${s.errors}`
  );
  dailyStats = {
    tagsResolved: 0, legacyTagsSkipped: 0, tagsNotFound: 0,
    rolesAdded: 0, rolesRemoved: 0, eventResolutions: 0, errors: 0, syncCycles: 0,
  };
}

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

  // Log daily summary at midnight and reset counters
  function scheduleNextSummary() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    setTimeout(() => {
      logDailySummary();
      setInterval(logDailySummary, 24 * 60 * 60 * 1000);
    }, midnight - now);
  }
  scheduleNextSummary();
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

client.on("guildMemberAdd", async (member) => {
  if (member.guild.id === "828708982506913792") {
    client.channels.cache.get("828765547663196191")?.send({
      content: `<@${member.id}>`,
      embeds: [constants.autowelcome.embed],
    });
    member.send({ content: constants.autowelcome.dm });
  }
  await tryResolveNewMember(member);
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  if (oldMember.user.username !== newMember.user.username) {
    await tryResolveNewMember(newMember);
  }
});

/**
 * When a user joins or changes their username, check if they match
 * an unresolved spreadsheet tag. If so, resolve immediately.
 */
async function tryResolveNewMember(member) {
  const username = member.user.username.toLowerCase();
  if (!unresolvedTags.has(username)) return;

  try {
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const row = rows.find(
      (r) => r.DiscordTagCache !== r.DiscordTag &&
             !r.DiscordTag.includes('#') &&
             r.DiscordTag.toLowerCase() === username
    );
    if (!row) return;

    row.DiscordId = member.user.id;
    row.DiscordTagCache = row.DiscordTag;
    await row.save();
    dailyStats.eventResolutions++;

    unresolvedTags.delete(username);
    failedTagLookups.delete(row.DiscordTag);

    // Assign verified role on all servers where this member is present
    for (const server of servers) {
      try {
        const guild = await client.guilds.fetch(server.guildid);
        const guildMember = guild.members.cache.get(member.user.id);
        if (!guildMember) continue;
        const verifiedRole = guild.roles.cache.get(server.verifiedroleid);
        if (!verifiedRole) continue;
        if (!guildMember.roles.cache.has(verifiedRole.id)) {
          await guildMember.roles.add(verifiedRole);
          dailyStats.rolesAdded++;
        }
      } catch (err) {
        dailyStats.errors++;
        console.error(`[event] Failed to assign role in guild ${server.guildid}:`, err);
      }
    }
  } catch (err) {
    dailyStats.errors++;
    console.error(`[event] Failed to resolve ${username}:`, err);
  }
}

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
    dailyStats.syncCycles++;

    // Step 1: Fetch all guild members first to populate client.users.cache
    for (const server of servers) {
      try {
        const guild = await client.guilds.fetch(server.guildid);
        await fetchAllMembersPaginated(guild);
      } catch (err) {
        dailyStats.errors++;
        console.error(`[sync] Failed to fetch members for guild ${server.guildid}:`, err);
      }
    }

    // Step 2: Resolve DiscordTags to DiscordIds using the now-populated cache
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    const updatedRows = rows.filter(
      (row) => row.DiscordTagCache !== row.DiscordTag
    );

    // Rebuild the unresolved tags set for event-driven resolution
    unresolvedTags.clear();

    const rowsToSave = [];
    for (const row of updatedRows) {
      if (row.DiscordTag.includes('#')) {
        row.DiscordTagCache = row.DiscordTag;
        rowsToSave.push(row);
        dailyStats.legacyTagsSkipped++;
        continue;
      }

      const lastFailed = failedTagLookups.get(row.DiscordTag);
      if (lastFailed && Date.now() - lastFailed < RETRY_INTERVAL_MS) {
        unresolvedTags.add(row.DiscordTag.toLowerCase());
        continue;
      }

      let user = client.users.cache.find(
        (u) => u.username.toLowerCase() === row.DiscordTag.toLowerCase()
      );
      if (!user) {
        failedTagLookups.set(row.DiscordTag, Date.now());
        unresolvedTags.add(row.DiscordTag.toLowerCase());
        dailyStats.tagsNotFound++;
        continue;
      }

      row.DiscordId = user.id;
      row.DiscordTagCache = row.DiscordTag;
      failedTagLookups.delete(row.DiscordTag);
      rowsToSave.push(row);
      dailyStats.tagsResolved++;
    }

    // Save rows sequentially with throttling to stay under Google Sheets
    // API quota (60 writes/min). First run may be slow with many legacy tags.
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (const row of rowsToSave) {
      try {
        await row.save();
        await delay(1100);
      } catch (err) {
        dailyStats.errors++;
        console.error(`[sync] Failed to save row for ${row.DiscordTag}:`, err.message);
      }
    }

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
            dailyStats.rolesAdded++;
          }
        }
        for (const userId of negDiff) {
          const member = guild.members.cache.get(userId);
          if (member) {
            await member.roles.remove(verifiedRole);
            dailyStats.rolesRemoved++;
          }
        }
      } catch (err) {
        dailyStats.errors++;
        console.error(`[sync] Failed to sync roles for guild ${server.guildid}:`, err);
      }
    }
  } catch (err) {
    dailyStats.errors++;
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


