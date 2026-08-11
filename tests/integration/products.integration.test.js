jest.mock('../../src/services/paymentServiceClient');
jest.mock('../../src/services/emailServiceClient');
jest.mock('../../src/services/waveServiceClient');

const request = require('supertest');
const { startTestEnv, stopTestEnv, resetTestEnv, signToken } = require('../helpers/testEnv');
const { createApp } = require('../../src/app');
const paymentServiceClient = require('../../src/services/paymentServiceClient');

let app;

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
  paymentServiceClient.getMerchantAccount.mockResolvedValue({ onboardingState: 'complete', payoutsEnabled: true });
});

async function createDraft(merchantToken, overrides = {}) {
  const res = await request(app)
    .post('/products')
    .set('Authorization', `Bearer ${merchantToken}`)
    .send({ title: 'Wavy Strom', priceCents: 2500, initialStock: 100, ...overrides });
  expect(res.status).toBe(201);
  return res.body.id;
}

test('GET /me/products returns the merchant\'s own products across every state, not just published', async () => {
  const merchantToken = signToken({ sub: 'merchant-a', roles: ['merchant'] });
  const draftId = await createDraft(merchantToken);
  const publishedId = await createDraft(merchantToken, { title: 'Published item' });
  await request(app).post(`/products/${publishedId}/publish`).set('Authorization', `Bearer ${merchantToken}`);

  const res = await request(app).get('/me/products').set('Authorization', `Bearer ${merchantToken}`);
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(2);
  const ids = res.body.items.map((p) => p.id);
  expect(ids).toEqual(expect.arrayContaining([draftId, publishedId]));
  const draftItem = res.body.items.find((p) => p.id === draftId);
  expect(draftItem.state).toBe('draft');
  const publishedItem = res.body.items.find((p) => p.id === publishedId);
  expect(publishedItem.remainingStock).toBe(100);
});

test('GET /me/products never returns another merchant\'s products', async () => {
  const merchantA = signToken({ sub: 'merchant-b', roles: ['merchant'] });
  const merchantB = signToken({ sub: 'merchant-c', roles: ['creator'] });
  await createDraft(merchantA);
  await createDraft(merchantB, { title: 'Not yours' });

  const res = await request(app).get('/me/products').set('Authorization', `Bearer ${merchantB}`);
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(1);
  expect(res.body.items[0].title).toBe('Not yours');
});

test('GET /me/products filters by state and rejects an unknown state value', async () => {
  const merchantToken = signToken({ sub: 'merchant-d', roles: ['merchant'] });
  const draftId = await createDraft(merchantToken);
  const publishedId = await createDraft(merchantToken, { title: 'Live drop' });
  await request(app).post(`/products/${publishedId}/publish`).set('Authorization', `Bearer ${merchantToken}`);

  const draftsOnly = await request(app)
    .get('/me/products')
    .query({ state: 'draft' })
    .set('Authorization', `Bearer ${merchantToken}`);
  expect(draftsOnly.status).toBe(200);
  expect(draftsOnly.body.items.map((p) => p.id)).toEqual([draftId]);

  const badState = await request(app)
    .get('/me/products')
    .query({ state: 'nope' })
    .set('Authorization', `Bearer ${merchantToken}`);
  expect(badState.status).toBe(400);
});

test('GET /me/products is rejected for a user without merchant/creator role', async () => {
  const consumerToken = signToken({ sub: 'consumer-1', roles: ['consumer'] });
  const res = await request(app).get('/me/products').set('Authorization', `Bearer ${consumerToken}`);
  expect(res.status).toBe(403);
});

test('GET /me/products requires authentication', async () => {
  const res = await request(app).get('/me/products');
  expect(res.status).toBe(401);
});
