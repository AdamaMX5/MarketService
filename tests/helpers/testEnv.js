// Must be set before src/config/env.js is first required (its module-level readEnv()
// snapshots process.env exactly once), so this file must be the very first thing any
// integration test requires.
process.env.INTERNAL_API_KEY_PAYMENT_SERVICE = process.env.INTERNAL_API_KEY_PAYMENT_SERVICE || 'test-payment-key';
process.env.INTERNAL_API_KEY_WAVE_SERVICE = process.env.INTERNAL_API_KEY_WAVE_SERVICE || 'test-wave-key';
process.env.ORDER_HOLD_TTL_MIN = process.env.ORDER_HOLD_TTL_MIN || '5';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const RedisMock = require('ioredis-mock');

const { setPublicKey } = require('../../src/services/authKey');
const { setRedis } = require('../../src/db/redis');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

setPublicKey(publicKey);

let mongo;
let redis;

async function startTestEnv() {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  redis = new RedisMock();
  setRedis(redis);
}

async function stopTestEnv() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
}

async function resetTestEnv() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
  await redis.flushall();
}

function signToken({ sub = 'user-1', email = 'user@example.com', roles = [] } = {}) {
  return jwt.sign({ sub, email, roles, permissions: {} }, privateKey, { algorithm: 'RS256', expiresIn: '1h' });
}

// For negative-path tests only: signs an arbitrary payload with the same test
// keypair, so a missing `sub` (etc.) is rejected for its own sake, not because the
// signature happens to be invalid.
function signRawToken(payload) {
  return jwt.sign(payload, privateKey, { algorithm: 'RS256', expiresIn: '1h' });
}

module.exports = { startTestEnv, stopTestEnv, resetTestEnv, signToken, signRawToken };
