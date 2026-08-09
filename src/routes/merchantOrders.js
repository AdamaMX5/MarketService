const express = require('express');
const { Order } = require('../models/Order');
const { requireAuth, hasRole } = require('../middleware/auth');
const { asyncHandler, ApiError } = require('../middleware/errorHandler');
const { parsePagination } = require('../lib/pagination');
const { requestRefund } = require('../services/paymentServiceClient');
const { REFUNDABLE_ORDER_STATES: REFUNDABLE_STATES } = require('../services/orderEvents');
const { stringParam } = require('../lib/queryString');
const { STATES: ORDER_STATES } = require('../models/Order');

const router = express.Router();

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function isOwnerOrAdmin(user, order) {
  return user.id === order.merchantId || hasRole(user, 'admin');
}

async function loadOwnedOrder(id, user) {
  const order = await Order.findByIdSafe(id);
  if (!order) throw ApiError.notFound('Order not found');
  if (!isOwnerOrAdmin(user, order)) throw ApiError.forbidden('Not your order');
  return order;
}

router.get(
  '/orders',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = { merchantId: req.user.id };
    const productId = stringParam(req.query.productId);
    if (productId) filter.productId = productId;
    const state = stringParam(req.query.state);
    if (state) {
      if (!ORDER_STATES.includes(state)) {
        throw ApiError.badRequest(`state must be one of: ${ORDER_STATES.join(', ')}`);
      }
      filter.state = state;
    }

    const [items, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Order.countDocuments(filter),
    ]);
    res.json({ items, page, limit, total });
  })
);

router.post(
  '/orders/:id/ship',
  requireAuth,
  asyncHandler(async (req, res) => {
    const order = await loadOwnedOrder(req.params.id, req.user);
    const trackingRef = req.body && req.body.trackingRef;
    if (
      trackingRef !== undefined &&
      (typeof trackingRef !== 'string' || trackingRef.length > 200 || CONTROL_CHARS.test(trackingRef))
    ) {
      throw ApiError.badRequest('trackingRef must be a plain string of at most 200 characters');
    }
    const shipped = await Order.findOneAndUpdate(
      { _id: order._id, state: 'paid' },
      { $set: { state: 'shipped', ...(trackingRef ? { trackingRef } : {}) } },
      { new: true }
    );
    if (!shipped) throw ApiError.conflict('Only a paid order can be shipped');
    res.json(shipped);
  })
);

router.post(
  '/orders/:id/refund',
  requireAuth,
  asyncHandler(async (req, res) => {
    const order = await loadOwnedOrder(req.params.id, req.user);
    if (!REFUNDABLE_STATES.includes(order.state)) {
      throw ApiError.conflict(`A ${order.state} order cannot be refunded`);
    }
    if (!order.paymentRef) throw ApiError.conflict('Order has no payment to refund');

    // Claimed atomically so a retried call can never fire two refund requests; the
    // actual state flip to `refunded` happens later via the PaymentService webhook.
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, refundRequestedAt: null, state: { $in: REFUNDABLE_STATES } },
      { $set: { refundRequestedAt: new Date() } },
      { new: true }
    );
    if (!claimed) throw ApiError.conflict('Refund already requested for this order');

    try {
      await requestRefund({ sessionId: claimed.paymentRef });
    } catch (error) {
      await Order.updateOne({ _id: claimed._id }, { $set: { refundRequestedAt: null } });
      throw error;
    }

    res.status(202).json({ status: 'refund_requested' });
  })
);

module.exports = router;
