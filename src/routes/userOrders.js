const express = require('express');
const { Product } = require('../models/Product');
const { Order } = require('../models/Order');
const { requireAuth, hasRole } = require('../middleware/auth');
const { asyncHandler, ApiError } = require('../middleware/errorHandler');
const { parsePagination } = require('../lib/pagination');
const { validateOrderCreate } = require('../lib/orderValidation');
const { startCheckout } = require('../services/checkout');

const router = express.Router();

function isOwnerOrAdmin(user, product) {
  return user.id === product.merchantId || hasRole(user, 'admin');
}

// Non-owners get 404 for draft/archived (existence isn't leaked); a purchasable
// product must additionally be published, not sold out, and past its dropAt.
async function loadPurchasableProduct(id, user) {
  const product = await Product.findByIdSafe(id);
  if (!product) throw ApiError.notFound('Product not found');
  if (product.state === 'draft' || product.state === 'archived') {
    if (!isOwnerOrAdmin(user, product)) throw ApiError.notFound('Product not found');
    throw ApiError.conflict('Product is not available for purchase');
  }
  if (product.state === 'soldout') throw ApiError.conflict('Product is sold out');
  if (product.dropAt && new Date() < product.dropAt) {
    throw ApiError.conflict('Product has not dropped yet');
  }
  return product;
}

router.post(
  '/products/:id/orders',
  requireAuth,
  asyncHandler(async (req, res) => {
    const product = await loadPurchasableProduct(req.params.id, req.user);
    const { quantity, shippingAddress } = validateOrderCreate(product, req.body);

    let result;
    try {
      result = await startCheckout({ product, user: req.user, quantity, shippingAddress });
    } catch (error) {
      if (error.code === 'SOLDOUT') throw ApiError.conflict('Product is sold out');
      if (error.code === 'MAX_PER_USER_EXCEEDED') throw ApiError.conflict('maxPerUser limit exceeded');
      throw error;
    }

    res.status(201).json({ orderId: String(result.order._id), checkoutUrl: result.checkoutUrl });
  })
);

router.get(
  '/me/orders',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = { userId: req.user.id };
    const [items, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Order.countDocuments(filter),
    ]);
    res.json({ items, page, limit, total });
  })
);

router.get(
  '/me/orders/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const order = await Order.findByIdSafe(req.params.id);
    if (!order || order.userId !== req.user.id) throw ApiError.notFound('Order not found');
    res.json(order);
  })
);

module.exports = router;
