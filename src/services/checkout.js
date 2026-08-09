const env = require('../config/env');
const { Order } = require('../models/Order');
const { reserveStock } = require('../lib/stock');
const { releaseHold, releaseReservedStock, markSoldoutIfExhausted } = require('../lib/orderTransitions');
const { createCheckoutSession, platformFeeCents } = require('./paymentServiceClient');

function reservationDeadline(now = new Date()) {
  return new Date(now.getTime() + env.ORDER_HOLD_TTL_MIN * 60 * 1000);
}

// Reserves stock, creates the hold, then creates the PaymentService session. Rolls
// back (stock + order) at whichever step fails, mirroring TicketService's startCheckout
// so a failed checkout never leaves stock stranded until the expiry cron catches up.
async function startCheckout({ product, user, quantity, shippingAddress }) {
  const remaining = await reserveStock(product.id, user.id, quantity, product.maxPerUser);
  await markSoldoutIfExhausted(product.id, remaining);

  const amountCents = product.priceCents * quantity;

  let order;
  try {
    order = await Order.create({
      userId: user.id,
      merchantId: product.merchantId,
      productId: product.id,
      quantity,
      amountCents,
      state: 'pendingPayment',
      shippingAddress: shippingAddress || null,
      buyerEmail: user.email || null,
      reservedUntil: reservationDeadline(),
    });
  } catch (error) {
    await releaseReservedStock(product.id, user.id, quantity);
    throw error;
  }

  try {
    const session = await createCheckoutSession({
      sourceId: String(order._id),
      merchantId: product.merchantId,
      lineItems: [{ name: product.title, amountCents: product.priceCents, quantity }],
      feeCents: platformFeeCents(amountCents),
      successUrl: `${env.APP_BASE_URL}/checkout/success?orderId=${order._id}`,
      cancelUrl: `${env.APP_BASE_URL}/checkout/cancel?orderId=${order._id}`,
    });
    order.paymentRef = session.sessionId;
    await order.save();
    return { order, checkoutUrl: session.checkoutUrl };
  } catch (error) {
    await releaseHold(order);
    throw error;
  }
}

module.exports = { startCheckout, reservationDeadline };
