require('dotenv').config();

// Set up database
var Database = require('better-sqlite3');
var db = new Database('ecdb.db');

// Initialize database
db.prepare("CREATE TABLE IF NOT EXISTS verification (discord_id TEXT, code TEXT)").run();

// Closes database connection on server shutdown
process.on('SIGINT', () => {
  db.close();
});

// Set up bot
const Discord = require('discord.js');
const bot = new Discord.Client();

// Set up bot commands
bot.commands = new Discord.Collection();
const botCommands = require('./commands');

Object.keys(botCommands).map(key => {
  bot.commands.set(botCommands[key].name, botCommands[key]);
});

const TOKEN = process.env.TOKEN;

bot.login(TOKEN);

bot.on('ready', () => {
  console.info(`Logged in as ${bot.user.tag}!`);
  bot.user.setPresence({ game: { name: 'with my sourcecode', type: "playing", url: "https://github.com/ShinyHobo/ec-bot"}}); 
});

// Watch the message history for commands
bot.on('message', msg => {
  if(msg.author.bot) {
    return;
  }

  let args = msg.content.split(/ +/);
  const command = args.shift().toLowerCase();
  args = [db].concat(args);
  console.info(`Called command: ${command}`);

  if (!bot.commands.has(command)) return;

  try {
    bot.commands.get(command).execute(msg, args);
  } catch (error) {
    console.error(error);
    msg.reply('There was an error trying to execute that command!');
  }
});