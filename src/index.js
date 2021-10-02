require('dotenv').config();

// Set up database
var sqlite3 = require('sqlite3').verbose();
var db = new sqlite3.Database('ecdb');

// Initialize database
db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS verification (discord_id TEXT, code TEXT)");
});

// Closes database connection on server shutdown
process.on('SIGINT', () => {
  db.close();
  server.close();
});

// Set up bot
const Discord = require('discord.js');
const bot = new Discord.Client();
bot.commands = new Discord.Collection();
const botCommands = require('./commands');

Object.keys(botCommands).map(key => {
  bot.commands.set(botCommands[key].name, botCommands[key]);
});

const TOKEN = process.env.TOKEN;

bot.login(TOKEN);

bot.on('ready', () => {
  console.info(`Logged in as ${bot.user.tag}!`);
});

// Watch the message history for commands
bot.on('message', msg => {
  const args = msg.content.split(/ +/);
  const command = args.shift().toLowerCase();
  console.info(`Called command: ${command}`);

  if (!bot.commands.has(command)) return;

  try {
    bot.commands.get(command).execute(msg, args);
  } catch (error) {
    console.error(error);
    msg.reply('There was an error trying to execute that command!');
  }
});