const env = require('../config/env');
const { createClient, lazyClient, propagate } = require('./upstream');

const getInternalClient = lazyClient(() =>
  createClient(env.PAYMENT_SERVICE_URL, { 'X-API-Key': env.PAYMENT_SERVICE_API_KEY })
);

function platformFeeCents(amountCents) {
  return Math.round((amountCents * env.PLATFORM_FEE_BPS) / 10000);
}

async function createCheckoutSession(payload) {
  try {
    const { data } = await getInternalClient().post('/internal/sessions', {
      sourceService: 'market',
      ...payload,
    });
    return { sessionId: String(data.sessionId), checkoutUrl: String(data.checkoutUrl) };
  } catch (error) {
    return propagate(error, 'PaymentService', [409]);
  }
}

async function requestRefund({ sessionId, amountCents }) {
  try {
    await getInternalClient().post('/internal/refunds', { sessionId, amountCents });
    return true;
  } catch (error) {
    return propagate(error, 'PaymentService', [400, 404]);
  }
}

// Reads the caller's own merchant account by forwarding their Bearer JWT, so no
// extra internal endpoint is needed on the PaymentService side.
async function getMerchantAccount(bearerToken) {
  try {
    const client = createClient(env.PAYMENT_SERVICE_URL, { Authorization: `Bearer ${bearerToken}` });
    const { data } = await client.get('/accounts/me');
    return { onboardingState: data.onboardingState, payoutsEnabled: Boolean(data.payoutsEnabled) };
  } catch (error) {
    if (error.response?.status === 404) return { onboardingState: 'pending', payoutsEnabled: false };
    return propagate(error, 'PaymentService', [401, 403]);
  }
}

module.exports = { createCheckoutSession, requestRefund, getMerchantAccount, platformFeeCents };
