const { Order } = require('../models/Order');
const { Product } = require('../models/Product');
const { releaseHoldStock, releaseRefundStock } = require('./stock');

// The single gate for every order state change: only one caller can win a given
// transition, which is what makes payment callbacks and the expiry cron idempotent.
async function transitionOrder(orderId, fromStates, toState, extraFields = {}) {
  return Order.findOneAndUpdate(
    { _id: orderId, state: { $in: fromStates } },
    { $set: { state: toState, ...extraFields } },
    { new: true }
  );
}

// Best-effort: a product flipped to soldout becomes purchasable again once stock is
// released. Never blocks the release itself if this update fails or races.
async function reopenProductIfSoldout(productId) {
  await Product.updateOne({ _id: productId, state: 'soldout' }, { $set: { state: 'published' } });
}

// Best-effort: once the reserve script returns exactly 0 remaining units, mark the
// product soldout so the catalog stops listing it while holds are still outstanding.
async function markSoldoutIfExhausted(productId, remaining) {
  if (remaining === 0) {
    await Product.updateOne({ _id: productId, state: 'published' }, { $set: { state: 'soldout' } });
  }
}

// Gives a still-reserved hold's stock (and the buyer's maxPerUser allowance) back,
// and reopens the product if it had flipped to soldout. Shared by the cron/webhook
// hold-expiry path and by checkout.js's rollback when creating the Order itself fails.
async function releaseReservedStock(productId, userId, quantity) {
  const remaining = await releaseHoldStock(productId, userId, quantity);
  if (remaining > 0) await reopenProductIfSoldout(productId);
  return remaining;
}

// Cancels a still-pendingPayment order and gives its held stock back. Guarded by the
// pendingPayment state check, so a double-release (cron racing a webhook) is a no-op.
async function releaseHold(order) {
  const cancelled = await transitionOrder(order._id, ['pendingPayment'], 'cancelled', {
    reservedUntil: null,
  });
  if (!cancelled) return null;
  await releaseReservedStock(cancelled.productId, cancelled.userId, cancelled.quantity);
  return cancelled;
}

// Releases stock for a refunded order. Deliberately does NOT restore the buyer's
// maxPerUser allowance (see releaseRefundStock) — a refund on a limited drop must
// not let the same buyer re-purchase the same allotment ("refund farming").
async function releaseRefund(order) {
  const remaining = await releaseRefundStock(order.productId, order.quantity);
  if (remaining > 0) await reopenProductIfSoldout(order.productId);
  return remaining;
}

module.exports = {
  transitionOrder,
  releaseHold,
  releaseRefund,
  releaseReservedStock,
  reopenProductIfSoldout,
  markSoldoutIfExhausted,
};
