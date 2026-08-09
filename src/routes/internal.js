const express = require('express');
const { Product } = require('../models/Product');
const { requireApiKey } = require('../middleware/internalAuth');
const { asyncHandler, ApiError } = require('../middleware/errorHandler');
const { applyPaymentEvent } = require('../services/orderEvents');
const { remainingStock } = require('../lib/stock');
const { presentProduct } = require('../lib/presenters');

const router = express.Router();

router.use(requireApiKey);

router.post(
  '/internal/payment-events',
  asyncHandler(async (req, res) => {
    // Only PaymentService may flip order state — any other internal caller is a
    // read-only consumer of GET /internal/products/:id, not a payment authority.
    if (req.callerService !== 'PAYMENT_SERVICE') {
      throw ApiError.forbidden('Caller is not authorized for payment callbacks');
    }
    const { sessionId, sourceId, event } = req.body || {};
    if (typeof sessionId !== 'string' || !sessionId) {
      throw ApiError.badRequest('sessionId is required and must be a string');
    }
    if (typeof sourceId !== 'string' || !sourceId) {
      throw ApiError.badRequest('sourceId is required and must be a string');
    }
    if (typeof event !== 'string' || !event) {
      throw ApiError.badRequest('event is required and must be a string');
    }
    const applied = await applyPaymentEvent({ sessionId, sourceId, event });
    res.json({ status: 'ok', applied });
  })
);

router.get(
  '/internal/products/:id',
  asyncHandler(async (req, res) => {
    const product = await Product.findByIdSafe(req.params.id);
    if (!product) throw ApiError.notFound('Product not found');
    res.json(presentProduct(product, await remainingStock(product.id)));
  })
);

module.exports = router;
