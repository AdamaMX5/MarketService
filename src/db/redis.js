const Redis = require('ioredis');
const env = require('../config/env');

let client = null;

function getRedis() {
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  }
  return client;
}

// Test setups inject an ioredis-mock instance instead of connecting to a real server.
function setRedis(instance) {
  client = instance;
}

async function disconnectRedis() {
  if (client) {
    await client.quit();
    client = null;
  }
}

module.exports = { getRedis, setRedis, disconnectRedis };
