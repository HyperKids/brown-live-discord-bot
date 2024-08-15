# Brown Live Discord Bot (Blueno)

This bot verifies Discord users as students of Brown University. The verification form is available at https://bit.ly/brownulive (only available to logged-in @brown.edu Google accounts).

With some light work, this bot can be used on any server (or group of servers). It will allow you to force new users to send you information via Google Forms, then get automatically verified on the server.

## .env file

Create a Google service account, and generate a new key. Download the `.json` file, and copy&paste both the service email and the private key into the `.env` file. Make sure there are double quotes around the private key, or it will not properly parse the new line characters.

Create a new Discord bot, copy its token, and paste it into the `.env` file.

Create a new Google Forms that collects Discord usernames, and copy the sheet ID (found in the sheet's URL) into the `.env` file.

## Format of the Google Form

From the Google Form you just created, rename the username column to `DiscordTag`, and add two empty columns `DiscordTagCache` and `DiscordId`. Make sure to share the sheet with your service email (in your `.env` file) and give it write access.

## verification.json

You will need to modify this file yourself to (1) add new servers, or (2) repurpose the bot for another non-Brown group. The fields are self-explanatory: the bot will add `verifiedroleid` to any user that is verified in `guildid`.

## Contributions

Contributions are welcome.

## Brown Live Bot down?

If the bot is down, you can contact Isaac (@HyperKids on Github). Alternatively, contact Brown Esports at Brown University - they own the service account for the Google Sheet that keeps this bot up.
