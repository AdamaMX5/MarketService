const RedisMock = require('ioredis-mock');
const { setRedis } = require('../../src/db/redis');
const stock = require('../../src/lib/stock');

// ioredis-mock instances share one underlying store by default (they simulate a
// single real server), so a fresh `new RedisMock()` per test does NOT isolate data —
// reuse one instance and flushall() between tests instead.
const redis = new RedisMock();

beforeEach(async () => {
  setRedis(redis);
  await redis.flushall();
});

test('reserveStock decrements stock and tracks the bought counter', async () => {
  await stock.initStock('p1', 3);
  const remaining = await stock.reserveStock('p1', 'u1', 2, 5);
  expect(remaining).toBe(1);
  expect(await stock.remainingStock('p1')).toBe(1);
});

test('reserveStock throws SOLDOUT and rolls back so stock never goes negative', async () => {
  await stock.initStock('p1', 1);
  await expect(stock.reserveStock('p1', 'u1', 2, 5)).rejects.toMatchObject({ code: 'SOLDOUT' });
  expect(await stock.remainingStock('p1')).toBe(1);
});

test('reserveStock throws MAX_PER_USER_EXCEEDED without touching stock', async () => {
  await stock.initStock('p1', 10);
  await expect(stock.reserveStock('p1', 'u1', 3, 2)).rejects.toMatchObject({ code: 'MAX_PER_USER_EXCEEDED' });
  expect(await stock.remainingStock('p1')).toBe(10);
});

test('maxPerUser accumulates across multiple reservations by the same user', async () => {
  await stock.initStock('p1', 10);
  await stock.reserveStock('p1', 'u1', 1, 2);
  await stock.reserveStock('p1', 'u1', 1, 2);
  await expect(stock.reserveStock('p1', 'u1', 1, 2)).rejects.toMatchObject({ code: 'MAX_PER_USER_EXCEEDED' });
});

test('releaseHoldStock gives quantity back to both stock and the bought counter', async () => {
  await stock.initStock('p1', 5);
  await stock.reserveStock('p1', 'u1', 2, 2);
  const remaining = await stock.releaseHoldStock('p1', 'u1', 2);
  expect(remaining).toBe(5);
  // bought is back to 0, so the same user can reserve up to maxPerUser again
  const again = await stock.reserveStock('p1', 'u1', 2, 2);
  expect(again).toBe(3);
});

test('releaseRefundStock gives quantity back to stock only, never the bought counter', async () => {
  await stock.initStock('p1', 5);
  await stock.reserveStock('p1', 'u1', 2, 2);
  const remaining = await stock.releaseRefundStock('p1', 2);
  expect(remaining).toBe(5);
  // bought is still 2/2, so this user cannot "farm" the allowance via refund + rebuy
  await expect(stock.reserveStock('p1', 'u1', 1, 2)).rejects.toMatchObject({ code: 'MAX_PER_USER_EXCEEDED' });
});

test('remainingStockBatch resolves multiple products in one round trip', async () => {
  await stock.initStock('p1', 5);
  await stock.initStock('p2', 0);
  const result = await stock.remainingStockBatch(['p1', 'p2', 'p3']);
  expect(result.get('p1')).toBe(5);
  expect(result.get('p2')).toBe(0);
  expect(result.get('p3')).toBeNull();
});

test('50 concurrent reservations against stock of 10 yield exactly 10 winners and stock 0', async () => {
  await stock.initStock('p1', 10);
  const results = await Promise.allSettled(
    Array.from({ length: 50 }, (_, i) => stock.reserveStock('p1', `u${i}`, 1, 1))
  );
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const soldout = results.filter((r) => r.status === 'rejected' && r.reason.code === 'SOLDOUT');
  expect(fulfilled.length).toBe(10);
  expect(soldout.length).toBe(40);
  expect(await stock.remainingStock('p1')).toBe(0);
});
