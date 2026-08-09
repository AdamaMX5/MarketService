const { getRedis } = require('../db/redis');

// Sentinels returned by the reserve script (see below) — everything >= 0 is the
// remaining stock after a successful reservation.
const SOLDOUT = -1;
const MAX_PER_USER_EXCEEDED = -2;

// One round trip, no race condition: checks maxPerUser, then atomically decrements
// stock. A negative result after the decrement means sold out and is rolled back
// before returning, so `stock:{productId}` never goes negative even transiently.
const RESERVE_LUA = `
  local bought = tonumber(redis.call('GET', KEYS[2]) or '0')
  local qty = tonumber(ARGV[1])
  local maxPerUser = tonumber(ARGV[2])

  if bought + qty > maxPerUser then
    return -2
  end

  local stock = redis.call('DECRBY', KEYS[1], qty)
  if stock < 0 then
    redis.call('INCRBY', KEYS[1], qty)
    return -1
  end

  redis.call('INCRBY', KEYS[2], qty)
  return stock
`;

// Gives quantity back to both the stock pool and the user's bought counter. Only
// correct for a hold that never became a real purchase (expiry / cancelled checkout
// session) — restoring the allowance here is what lets the same user try again.
const RELEASE_HOLD_LUA = `
  local stock = redis.call('INCRBY', KEYS[1], ARGV[1])
  redis.call('DECRBY', KEYS[2], ARGV[1])
  if tonumber(redis.call('GET', KEYS[2])) < 0 then
    redis.call('SET', KEYS[2], 0)
  end
  return stock
`;

// Gives quantity back to the stock pool only. Used for a `refunded` order: the
// bought counter must NOT be restored here, or a user could buy out a limited drop,
// refund it, and buy the same maxPerUser allowance again ("refund farming").
const RELEASE_REFUND_LUA = `
  return redis.call('INCRBY', KEYS[1], ARGV[1])
`;

function stockKey(productId) {
  return `stock:${productId}`;
}

function boughtKey(productId, userId) {
  return `bought:${productId}:${userId}`;
}

function ensureCommandsDefined(redis) {
  if (!redis.reserveStock) {
    redis.defineCommand('reserveStock', { numberOfKeys: 2, lua: RESERVE_LUA });
  }
  if (!redis.releaseHoldStock) {
    redis.defineCommand('releaseHoldStock', { numberOfKeys: 2, lua: RELEASE_HOLD_LUA });
  }
  if (!redis.releaseRefundStock) {
    redis.defineCommand('releaseRefundStock', { numberOfKeys: 1, lua: RELEASE_REFUND_LUA });
  }
}

/** Sets the sellable stock pool for a product to `initialStock` (called on publish). */
async function initStock(productId, initialStock) {
  const redis = getRedis();
  await redis.set(stockKey(productId), initialStock);
}

/**
 * Atomically reserves `quantity` units for `userId`, honoring `maxPerUser`.
 * Returns the remaining stock (>= 0) on success, or throws SoldoutError /
 * MaxPerUserExceededError.
 */
async function reserveStock(productId, userId, quantity, maxPerUser) {
  const redis = getRedis();
  ensureCommandsDefined(redis);
  const result = await redis.reserveStock(
    stockKey(productId),
    boughtKey(productId, userId),
    quantity,
    maxPerUser
  );
  if (result === MAX_PER_USER_EXCEEDED) {
    const err = new Error('maxPerUser exceeded');
    err.code = 'MAX_PER_USER_EXCEEDED';
    throw err;
  }
  if (result === SOLDOUT) {
    const err = new Error('Sold out');
    err.code = 'SOLDOUT';
    throw err;
  }
  return result;
}

/** Releases a hold that never became a real purchase (expiry / cancelled checkout). */
async function releaseHoldStock(productId, userId, quantity) {
  const redis = getRedis();
  ensureCommandsDefined(redis);
  return redis.releaseHoldStock(stockKey(productId), boughtKey(productId, userId), quantity);
}

/** Releases stock for a refunded order — the maxPerUser allowance is NOT restored. */
async function releaseRefundStock(productId, quantity) {
  const redis = getRedis();
  ensureCommandsDefined(redis);
  return redis.releaseRefundStock(stockKey(productId), quantity);
}

async function remainingStock(productId) {
  const redis = getRedis();
  const value = await redis.get(stockKey(productId));
  return value === null ? null : parseInt(value, 10);
}

/** Batched remainingStock lookup for catalog listings — one round trip via MGET. */
async function remainingStockBatch(productIds) {
  if (productIds.length === 0) return new Map();
  const redis = getRedis();
  const values = await redis.mget(...productIds.map(stockKey));
  return new Map(productIds.map((id, i) => [id, values[i] === null ? null : parseInt(values[i], 10)]));
}

module.exports = {
  initStock,
  reserveStock,
  releaseHoldStock,
  releaseRefundStock,
  remainingStock,
  remainingStockBatch,
};
