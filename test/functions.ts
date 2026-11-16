/**
 * This contains all overriden framework functions so
 * the app logic itself can be tested
 */
const fs = require('fs');
const YAML = require('yaml');
const config = YAML.parse(fs.readFileSync(process.env.SUPPORTBOT_CONFIG_PATH || './config/config.yaml', 'utf8'));

const msgsToUser: Array<string> = [];
const msgsToStaff: Array<string> = [];
let waiting = true;

const {createBot, main: appMain} = require('../src/index');
const bot = createBot();  // This is TelegramAddon instance

function main(...args: any[]) {
  const cache = require('../src/cache').default;
  cache.config = JSON.parse(JSON.stringify(config));
  return appMain(...args);
}

// Override both sendMessage methods to capture messages
const originalSendMessage = bot.sendMessage;
bot.sendMessage = function(id, text, options, signal) {
  if (id == config.staffchat_id) {
    // msg to staff
    msgsToStaff.push(text);
  } else {
    // msg to user
    msgsToUser.push(text);
  }
  waiting = false;
  return Promise.resolve({message_id: 1});
};

// Also override grammy Bot's API sendMessage
bot.bot.api.sendMessage = function(id, text: string, options) {
  if (id == config.staffchat_id) {
    // msg to staff
    msgsToStaff.push(text);
  } else {
    // msg to user
    msgsToUser.push(text);
  }
  waiting = false;
  return Promise.resolve({message_id: 1});
};

bot.bot.launch = function() {
  // Do nothing
  console.log('not launching');
};

export {bot, main, waiting, msgsToUser, msgsToStaff};
