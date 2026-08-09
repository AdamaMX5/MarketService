const { Order } = require('../models/Order');
const { Product } = require('../models/Product');
const { ApiError } = require('../middleware/errorHandler');
const { transitionOrder, releaseHold, releaseRefund } = require('../lib/orderTransitions');
const { sendEmail } = require('./emailServiceClient');
const { incrementWaveStats } = require('./waveServiceClient');
const { reportException } = require('./exceptionServiceClient');

// Orders reachable from a merchant-triggered refund (see merchantOrders.js's
// REFUNDABLE_STATES) must match exactly what this handler accepts, or a refund that
// PaymentService actually processes can silently no-op here: money goes back to the
// buyer, but the order is stuck in its old state and stock is never released.
const REFUNDABLE_ORDER_STATES = ['paid', 'shipped', 'delivered'];

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );
}

function confirmationBody(product, order) {
  return [
    `<h1>${escapeHtml(product ? product.title : 'Your order')}</h1>`,
    `<p>Order: ${escapeHtml(String(order._id))}</p>`,
    `<p>Quantity: ${order.quantity}</p>`,
    `<p>Total: ${(order.amountCents / 100).toFixed(2)} ${(product && product.currency) || 'EUR'}</p>`,
  ].join('\n');
}

async function handlePaid(order) {
  const paid = await transitionOrder(order._id, ['pendingPayment'], 'paid', { reservedUntil: null });
  if (!paid) return false;

  const product = await Product.findByIdSafe(paid.productId);
  if (paid.buyerEmail) {
    await sendEmail({
      to: paid.buyerEmail,
      subject: `Your order for ${product ? product.title : 'your purchase'}`,
      body: confirmationBody(product, paid),
      type: 'order-confirmation',
      metadata: { orderId: String(paid._id) },
    });
  }
  if (product && product.waveId) {
    // WaveService's own internal /stats contract currently only accepts a
    // `checkins` counter for the ActivationService's check-in flow — there is no
    // `purchases`/`sales` field on the Wave stats schema yet. This call documents
    // the intended integration point per MarketService.md; until WaveService adds
    // such a field the call is expected to be rejected, which is fine since it is
    // fire-and-forget and never affects order state.
    await incrementWaveStats(product.waveId, 'purchases', paid.quantity);
  }
  return true;
}

async function handleExpired(order) {
  return Boolean(await releaseHold(order));
}

async function handleRefunded(order) {
  const refunded = await transitionOrder(order._id, REFUNDABLE_ORDER_STATES, 'refunded');
  if (!refunded) return false;
  await releaseRefund(refunded);
  return true;
}

const HANDLERS = { paid: handlePaid, expired: handleExpired, refunded: handleRefunded };

// Idempotent by construction: every handler is a guarded state transition, so a
// replayed callback finds the order already past that state and does nothing.
async function applyPaymentEvent({ sessionId, sourceId, event }) {
  // Own-property lookup only: "constructor" or "toString" would otherwise resolve
  // to an inherited function and be invoked as if it were a handler.
  if (!Object.hasOwn(HANDLERS, event)) throw ApiError.badRequest('Unsupported payment event');
  const handler = HANDLERS[event];

  const order = await Order.findByIdSafe(sourceId);
  if (!order) throw ApiError.notFound('Order not found');
  // paymentRef is set synchronously right after the PaymentService session is
  // created (see checkout.js), before checkout ever returns to the caller — so a
  // legitimate webhook can never outrace it. Requiring it here (rather than only
  // checking equality when present) closes the window where an order that hasn't
  // gotten a paymentRef yet would skip the binding check entirely.
  if (!order.paymentRef || order.paymentRef !== sessionId) {
    throw ApiError.conflict('Session does not belong to this order');
  }

  const applied = await handler(order);
  // A `paid` event that finds the order already past pendingPayment means Stripe
  // captured real money for a hold that had already expired/cancelled on our side
  // (the checkout session can outlive the 5-minute hold) — that needs a human, not
  // a silent no-op.
  if (!applied && event === 'paid') {
    reportException({
      message: 'PaymentService paid callback landed on an order that was no longer pendingPayment',
      metadata: { orderId: String(order._id), sessionId, currentState: order.state },
    });
  }
  return applied;
}

module.exports = { applyPaymentEvent, REFUNDABLE_ORDER_STATES };
