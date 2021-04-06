require("dotenv").config();
const Discord = require("discord.js");
const client = new Discord.Client();
const fs = require("fs");

const { GoogleSpreadsheet } = require("google-spreadsheet");
const doc = new GoogleSpreadsheet(
  "19-2UBOz-pBC08JnTBp0sgXPkCrHlMJw3Gd5WkxWnEAc"
);

client.on("ready", () => {
  // client.user.setActivity("the BEST server!", { type: "WATCHING" });
  console.log(`Logged in as ${client.user.tag}!`);
  updateVerifiedStudents();
  setInterval(() => updateVerifiedStudents(), 1000 * 60);
});

async function updateVerifiedStudents() {
  // console.log("updateVerifiedStudents was called at " + new Date());
  if (
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY
  ) {
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY,
    });
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const col0 = rows.map((item) => item.DiscordTag);
    let servers = JSON.parse(fs.readFileSync("./verification.json", "utf-8"));
    servers.forEach(({ guildid, verifiedroleid }) => {
      client.guilds.fetch(guildid).then((guild) => {
        guild.members.fetch().then((members) => {
          var verifiedrolemembers = guild.roles.cache
            .get(verifiedroleid)
            .members.map((m) => m.user.tag.toLowerCase());
          var gsheettags = col0.map((v) => v.toLowerCase());
          var posdiff = gsheettags
            .filter((x) => !verifiedrolemembers.includes(x.toLowerCase()))
            .map((v) => v.toLowerCase()); // filters to differences between the two arrays - verifiedrolemembers is
          // current members on the server with the "Verified" role, res.data.values[0]
          // is Google Form list of DiscordTags that should have the role
          // var posdiff = diff // diff.filter((x) => gsheettags.includes(x));
          var negdiff = verifiedrolemembers
            .filter((x) => !gsheettags.includes(x.toLowerCase()))
            .map((v) => v.toLowerCase()); // diff.filter((x) => verifiedrolemembers.includes(x));
          var diff = posdiff.concat(negdiff);
          diff.forEach((DiscordTag) => {
            let user = client.users.cache.find(
              (u) => u.tag.toLowerCase() === DiscordTag.toLowerCase()
            )?.id;
            if (user) {
              let guilduser = guild.members
                .fetch(user)
                .then((guilduser) => {
                  let username = guilduser.user.username.toLowerCase();
                  let discrim = guilduser.user.discriminator;
                  if (posdiff.includes(username + "#" + discrim)) {
                    guilduser.roles.add(verifiedroleid).catch(console.error);
                    console.log("+" + username);
                  } else if (negdiff.includes(username + "#" + discrim)) {
                    guilduser.roles.remove(verifiedroleid).catch(console.error);
                    client.users.cache
                      .get(guilduser.id)
                      .send(
                        `Hi! Just letting you know that your \`Verified\` status was removed on the ${guild.name} server. This is likely caused by a change in your username, or by you unlinking your Discord account in the verification form. If you changed your username, please update it on the student verification form at https://bit.ly/brownulive.`
                      );
                    console.log("-" + username);
                  } else {
                    // console.error(
                    //   `No clue what to do with this user! ${
                    //     username + "#" + discrim
                    //   }`
                    // );
                  }
                })
                .catch(console.error);
            } else {
              // console.log(`${DiscordTag} is invalid!`);
            }
          });
        });
      });
    });
  } else {
    console.log(
      "GCP_API_KEY in .env is not defined! Unable to update verified student roles."
    );
  }
}

client.login(process.env.DISCORDBOTTOKEN);
