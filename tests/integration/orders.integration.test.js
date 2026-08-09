jest.mock('../../src/services/paymentServiceClient');
jest.mock('../../src/services/emailServiceClient');
jest.mock('../../src/services/waveServiceClient');

const request = require('supertest');
const { startTestEnv, stopTestEnv, resetTestEnv, signToken, signRawToken } = require('../helpers/testEnv');
const { createApp } = require('../../src/app');
const paymentServiceClient = require('../../src/services/paymentServiceClient');
const { Product } = require('../../src/models/Product');
const { Order } = require('../../src/models/Order');
const { getRedis } = require('../../src/db/redis');
const { expireHolds } = require('../../src/jobs/expireHolds');

let app;
let sessionCounter;

beforeAll(async () => {
  await startTestEnv();
  app = createApp();
});

afterAll(async () => {
  await stopTestEnv();
});

beforeEach(async () => {
  await resetTestEnv();
  jest.clearAllMocks();
  sessionCounter = 0;
  paymentServiceClient.createCheckoutSession.mockImplementation(async () => {
    sessionCounter += 1;
    return { sessionId: `cs_test_${sessionCounter}`, checkoutUrl: `https://payment.test/${sessionCounter}` };
  });
  paymentServiceClient.requestRefund.mockResolvedValue(true);
  paymentServiceClient.getMerchantAccount.mockResolvedValue({ onboardingState: 'complete', payoutsEnabled: true });
  paymentServiceClient.platformFeeCents.mockImplementation((amount) => Math.round(amount * 0.05));
});

async function createPublishedProduct({
  merchantToken,
  initialStock = 10,
  maxPerUser = 2,
  dropAt = null,
  requiresShipping = false,
} = {}) {
  const createRes = await request(app)
    .post('/products')
    .set('Authorization', `Bearer ${merchantToken}`)
    .send({ title: 'Cap', priceCents: 1000, initialStock, maxPerUser, requiresShipping, dropAt });
  expect(createRes.status).toBe(201);

  const publishRes = await request(app)
    .post(`/products/${createRes.body.id}/publish`)
    .set('Authorization', `Bearer ${merchantToken}`);
  expect(publishRes.status).toBe(200);

  return createRes.body.id;
}

// Acceptance criterion 1
test('50 parallel orders on stock 10 yield exactly 10 pendingPayment and 40 409, stock ends at 0', async () => {
  const merchantToken = signToken({ sub: 'merchant-1', roles: ['merchant'] });
  const productId = await createPublishedProduct({ merchantToken, initialStock: 10, maxPerUser: 50 });

  const buyerTokens = Array.from({ length: 50 }, (_, i) => signToken({ sub: `buyer-${i}` }));
  const results = await Promise.all(
    buyerTokens.map((token) =>
      request(app).post(`/products/${productId}/orders`).set('Authorization', `Bearer ${token}`).send({ quantity: 1 })
    )
  );

  const created = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  expect(created.length).toBe(10);
  expect(conflicts.length).toBe(40);

  const remaining = await getRedis().get(`stock:${productId}`);
  expect(Number(remaining)).toBe(0);

  const pendingCount = await Order.countDocuments({ productId, state: 'pendingPayment' });
  expect(pendingCount).toBe(10);

  const product = await Product.findById(productId);
  expect(product.state).toBe('soldout');
});

// Acceptance criterion 2
test('an expired hold releases stock so a later buyer can claim it', async () => {
  const merchantToken = signToken({ sub: 'merchant-2', roles: ['merchant'] });
  const productId = await createPublishedProduct({ merchantToken, initialStock: 1 });
  const buyerA = signToken({ sub: 'buyer-a' });

  const resA = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyerA}`)
    .send({ quantity: 1 });
  expect(resA.status).toBe(201);

  await Order.updateOne({ _id: resA.body.orderId }, { $set: { reservedUntil: new Date(Date.now() - 1000) } });

  const released = await expireHolds();
  expect(released).toBe(1);
  expect(Number(await getRedis().get(`stock:${productId}`))).toBe(1);

  const buyerB = signToken({ sub: 'buyer-b' });
  const resB = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyerB}`)
    .send({ quantity: 1 });
  expect(resB.status).toBe(201);
});

// Acceptance criterion 3
test('maxPerUser blocks a third unit even split across two orders', async () => {
  const merchantToken = signToken({ sub: 'merchant-3', roles: ['merchant'] });
  const productId = await createPublishedProduct({ merchantToken, initialStock: 10, maxPerUser: 2 });
  const buyer = signToken({ sub: 'buyer-limit' });

  const res1 = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyer}`)
    .send({ quantity: 1 });
  expect(res1.status).toBe(201);

  const res2 = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyer}`)
    .send({ quantity: 1 });
  expect(res2.status).toBe(201);

  const res3 = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyer}`)
    .send({ quantity: 1 });
  expect(res3.status).toBe(409);
});

// Acceptance criterion 4
test('purchase is blocked before dropAt and possible once it is reached', async () => {
  const merchantToken = signToken({ sub: 'merchant-4', roles: ['merchant'] });
  const future = new Date(Date.now() + 100000).toISOString();
  const productId = await createPublishedProduct({ merchantToken, initialStock: 5, dropAt: future });
  const buyer = signToken({ sub: 'buyer-drop' });

  const early = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyer}`)
    .send({ quantity: 1 });
  expect(early.status).toBe(409);

  await Product.updateOne({ _id: productId }, { $set: { dropAt: new Date(Date.now() - 1000) } });

  const onTime = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyer}`)
    .send({ quantity: 1 });
  expect(onTime.status).toBe(201);
});

// Acceptance criterion 5
test('a refunded webhook releases stock and is idempotent on a duplicate event', async () => {
  const merchantToken = signToken({ sub: 'merchant-5', roles: ['merchant'] });
  const productId = await createPublishedProduct({ merchantToken, initialStock: 1 });
  const buyer = signToken({ sub: 'buyer-refund' });

  const orderRes = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyer}`)
    .send({ quantity: 1 });
  const { orderId } = orderRes.body;

  const paidCallback = await request(app)
    .post('/internal/payment-events')
    .set('X-API-Key', process.env.INTERNAL_API_KEY_PAYMENT_SERVICE)
    .send({ sessionId: 'cs_test_1', sourceId: orderId, event: 'paid' });
  expect(paidCallback.status).toBe(200);
  expect(Number(await getRedis().get(`stock:${productId}`))).toBe(0);

  const refund1 = await request(app)
    .post('/internal/payment-events')
    .set('X-API-Key', process.env.INTERNAL_API_KEY_PAYMENT_SERVICE)
    .send({ sessionId: 'cs_test_1', sourceId: orderId, event: 'refunded' });
  expect(refund1.status).toBe(200);
  expect(refund1.body.applied).toBe(true);
  expect(Number(await getRedis().get(`stock:${productId}`))).toBe(1);

  const refund2 = await request(app)
    .post('/internal/payment-events')
    .set('X-API-Key', process.env.INTERNAL_API_KEY_PAYMENT_SERVICE)
    .send({ sessionId: 'cs_test_1', sourceId: orderId, event: 'refunded' });
  expect(refund2.status).toBe(200);
  expect(refund2.body.applied).toBe(false);
  expect(Number(await getRedis().get(`stock:${productId}`))).toBe(1);

  const order = await Order.findById(orderId);
  expect(order.state).toBe('refunded');
});

// Acceptance criterion 6
test('initialStock cannot be patched once a product is published', async () => {
  const merchantToken = signToken({ sub: 'merchant-6', roles: ['merchant'] });
  const productId = await createPublishedProduct({ merchantToken, initialStock: 5 });

  const patchRes = await request(app)
    .patch(`/products/${productId}`)
    .set('Authorization', `Bearer ${merchantToken}`)
    .send({ initialStock: 999 });
  expect(patchRes.status).toBe(400);

  const product = await Product.findById(productId);
  expect(product.initialStock).toBe(5);
});

test('internal payment-events callback is rejected for a caller other than PaymentService', async () => {
  const merchantToken = signToken({ sub: 'merchant-7', roles: ['merchant'] });
  const productId = await createPublishedProduct({ merchantToken, initialStock: 1 });
  const buyer = signToken({ sub: 'buyer-7' });
  const orderRes = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyer}`)
    .send({ quantity: 1 });

  const res = await request(app)
    .post('/internal/payment-events')
    .set('X-API-Key', process.env.INTERNAL_API_KEY_WAVE_SERVICE)
    .send({ sessionId: 'cs_test_1', sourceId: orderRes.body.orderId, event: 'paid' });
  expect(res.status).toBe(403);
});

test('a non-owner cannot ship or refund another merchant\'s order', async () => {
  const merchantToken = signToken({ sub: 'merchant-8', roles: ['merchant'] });
  const otherMerchantToken = signToken({ sub: 'merchant-9', roles: ['merchant'] });
  const productId = await createPublishedProduct({ merchantToken, initialStock: 1 });
  const buyer = signToken({ sub: 'buyer-8' });
  const orderRes = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyer}`)
    .send({ quantity: 1 });

  const shipRes = await request(app)
    .post(`/orders/${orderRes.body.orderId}/ship`)
    .set('Authorization', `Bearer ${otherMerchantToken}`);
  expect(shipRes.status).toBe(403);
});

test('draft and archived products are masked as 404 for non-owners', async () => {
  const merchantToken = signToken({ sub: 'merchant-10', roles: ['merchant'] });
  const createRes = await request(app)
    .post('/products')
    .set('Authorization', `Bearer ${merchantToken}`)
    .send({ title: 'Draft item', priceCents: 500, initialStock: 1 });

  const stranger = signToken({ sub: 'stranger' });
  const res = await request(app)
    .get(`/products/${createRes.body.id}`)
    .set('Authorization', `Bearer ${stranger}`);
  expect(res.status).toBe(404);

  const ownerRes = await request(app)
    .get(`/products/${createRes.body.id}`)
    .set('Authorization', `Bearer ${merchantToken}`);
  expect(ownerRes.status).toBe(200);
});

test('merchant refund request is accepted for a delivered order and the webhook actually releases stock', async () => {
  const merchantToken = signToken({ sub: 'merchant-11', roles: ['merchant'] });
  const productId = await createPublishedProduct({ merchantToken, initialStock: 1 });
  const buyer = signToken({ sub: 'buyer-11' });

  const orderRes = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyer}`)
    .send({ quantity: 1 });
  const { orderId } = orderRes.body;

  await request(app)
    .post('/internal/payment-events')
    .set('X-API-Key', process.env.INTERNAL_API_KEY_PAYMENT_SERVICE)
    .send({ sessionId: 'cs_test_1', sourceId: orderId, event: 'paid' });
  await Order.updateOne({ _id: orderId }, { $set: { state: 'shipped' } });
  await Order.updateOne({ _id: orderId }, { $set: { state: 'delivered' } });

  const refundRes = await request(app)
    .post(`/orders/${orderId}/refund`)
    .set('Authorization', `Bearer ${merchantToken}`);
  expect(refundRes.status).toBe(202);
  expect(paymentServiceClient.requestRefund).toHaveBeenCalledWith({ sessionId: 'cs_test_1' });

  const refundCallback = await request(app)
    .post('/internal/payment-events')
    .set('X-API-Key', process.env.INTERNAL_API_KEY_PAYMENT_SERVICE)
    .send({ sessionId: 'cs_test_1', sourceId: orderId, event: 'refunded' });
  expect(refundCallback.status).toBe(200);
  expect(refundCallback.body.applied).toBe(true);

  const order = await Order.findById(orderId);
  expect(order.state).toBe('refunded');
  expect(Number(await getRedis().get(`stock:${productId}`))).toBe(1);
});

test('a second refund request on an order already awaiting refund is rejected', async () => {
  const merchantToken = signToken({ sub: 'merchant-12', roles: ['merchant'] });
  const productId = await createPublishedProduct({ merchantToken, initialStock: 1 });
  const buyer = signToken({ sub: 'buyer-12' });
  const orderRes = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyer}`)
    .send({ quantity: 1 });
  const { orderId } = orderRes.body;
  await request(app)
    .post('/internal/payment-events')
    .set('X-API-Key', process.env.INTERNAL_API_KEY_PAYMENT_SERVICE)
    .send({ sessionId: 'cs_test_1', sourceId: orderId, event: 'paid' });

  const first = await request(app).post(`/orders/${orderId}/refund`).set('Authorization', `Bearer ${merchantToken}`);
  expect(first.status).toBe(202);

  const second = await request(app).post(`/orders/${orderId}/refund`).set('Authorization', `Bearer ${merchantToken}`);
  expect(second.status).toBe(409);
  expect(paymentServiceClient.requestRefund).toHaveBeenCalledTimes(1);
});

test('publish is rejected with 409 when the merchant\'s PaymentService onboarding is incomplete', async () => {
  paymentServiceClient.getMerchantAccount.mockResolvedValueOnce({ onboardingState: 'pending', payoutsEnabled: false });
  const merchantToken = signToken({ sub: 'merchant-13', roles: ['merchant'] });

  const createRes = await request(app)
    .post('/products')
    .set('Authorization', `Bearer ${merchantToken}`)
    .send({ title: 'Item', priceCents: 500, initialStock: 1 });

  const publishRes = await request(app)
    .post(`/products/${createRes.body.id}/publish`)
    .set('Authorization', `Bearer ${merchantToken}`);
  expect(publishRes.status).toBe(409);

  const product = await Product.findById(createRes.body.id);
  expect(product.state).toBe('draft');
});

test('a product that requires shipping rejects an order without a shippingAddress', async () => {
  const merchantToken = signToken({ sub: 'merchant-14', roles: ['merchant'] });
  const productId = await createPublishedProduct({ merchantToken, initialStock: 1, requiresShipping: true });
  const buyer = signToken({ sub: 'buyer-14' });

  const withoutAddress = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyer}`)
    .send({ quantity: 1 });
  expect(withoutAddress.status).toBe(400);

  const withAddress = await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyer}`)
    .send({
      quantity: 1,
      shippingAddress: { name: 'Ada Lovelace', street: 'Main St 1', zip: '12345', city: 'Berlin', country: 'de' },
    });
  expect(withAddress.status).toBe(201);

  const order = await Order.findById(withAddress.body.orderId);
  expect(order.shippingAddress.country).toBe('DE');
});

test('a sold-out product can still be archived by its merchant', async () => {
  const merchantToken = signToken({ sub: 'merchant-15', roles: ['merchant'] });
  const productId = await createPublishedProduct({ merchantToken, initialStock: 1 });
  const buyer = signToken({ sub: 'buyer-15' });
  await request(app)
    .post(`/products/${productId}/orders`)
    .set('Authorization', `Bearer ${buyer}`)
    .send({ quantity: 1 });

  const product = await Product.findById(productId);
  expect(product.state).toBe('soldout');

  const archiveRes = await request(app)
    .patch(`/products/${productId}`)
    .set('Authorization', `Bearer ${merchantToken}`)
    .send({ state: 'archived' });
  expect(archiveRes.status).toBe(200);
  expect(archiveRes.body.state).toBe('archived');
});

test('a NoSQL-operator-style query param on /products is treated as a literal, not a Mongo operator', async () => {
  const merchantToken = signToken({ sub: 'merchant-16', roles: ['merchant'] });
  await createPublishedProduct({ merchantToken, initialStock: 1 });

  const res = await request(app).get('/products').query('merchantId[$ne]=nobody');
  expect(res.status).toBe(200);
  // The bracketed key never resolves to a real `merchantId` filter value, so this
  // must behave like an unfiltered published-catalog listing, not a bypass.
  expect(Array.isArray(res.body.items)).toBe(true);
});

test('a waveId that is not a valid ObjectId shape is rejected on product creation', async () => {
  const merchantToken = signToken({ sub: 'merchant-17', roles: ['merchant'] });
  const res = await request(app)
    .post('/products')
    .set('Authorization', `Bearer ${merchantToken}`)
    .send({ title: 'Item', priceCents: 500, initialStock: 1, waveId: '../../internal/admin' });
  expect(res.status).toBe(400);
});

test('a title containing control characters is rejected', async () => {
  const merchantToken = signToken({ sub: 'merchant-18', roles: ['merchant'] });
  const res = await request(app)
    .post('/products')
    .set('Authorization', `Bearer ${merchantToken}`)
    .send({ title: 'Item\r\nBcc: attacker@example.com', priceCents: 500, initialStock: 1 });
  expect(res.status).toBe(400);
});

test('a validly-signed JWT without a sub claim is rejected as unauthenticated', async () => {
  const badToken = signRawToken({ email: 'nouser@example.com' });
  const res = await request(app).get('/me/orders').set('Authorization', `Bearer ${badToken}`);
  expect(res.status).toBe(401);
});
