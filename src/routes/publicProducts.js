const express = require('express');
const { Product } = require('../models/Product');
const { optionalAuth, hasRole } = require('../middleware/auth');
const { asyncHandler, ApiError } = require('../middleware/errorHandler');
const { parsePagination } = require('../lib/pagination');
const { presentProduct } = require('../lib/presenters');
const { remainingStock, remainingStockBatch } = require('../lib/stock');
const { stringParam } = require('../lib/queryString');

const router = express.Router();

// Only these two states are ever discoverable without ownership — draft/archived are
// masked as 404 for non-owners, mirroring WaveService's public-listing whitelist.
const PUBLIC_LIST_STATES = ['published', 'soldout'];

function isOwnerOrAdmin(user, product) {
  return !!user && (user.id === product.merchantId || hasRole(user, 'admin'));
}

router.get(
  '/products',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const requestedState = stringParam(req.query.state) || 'published';
    if (!PUBLIC_LIST_STATES.includes(requestedState)) {
      throw ApiError.badRequest(`state must be one of: ${PUBLIC_LIST_STATES.join(', ')}`);
    }
    const filter = { state: requestedState };
    const merchantId = stringParam(req.query.merchantId);
    if (merchantId) filter.merchantId = merchantId;
    const waveId = stringParam(req.query.waveId);
    if (waveId) filter.waveId = waveId;

    const [products, total] = await Promise.all([
      Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Product.countDocuments(filter),
    ]);
    // One MGET round trip for the whole page instead of one GET per product — this
    // is the hottest endpoint during a drop (doc's own load scenario: 20k concurrent
    // buyers), so N sequential Redis calls per request would not scale.
    const stockById = await remainingStockBatch(products.map((p) => p.id));
    const items = products.map((p) => presentProduct(p, stockById.get(p.id)));
    res.json({ items, page, limit, total });
  })
);

router.get(
  '/products/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const product = await Product.findByIdSafe(req.params.id);
    if (!product) throw ApiError.notFound('Product not found');
    if (!PUBLIC_LIST_STATES.includes(product.state) && !isOwnerOrAdmin(req.user, product)) {
      throw ApiError.notFound('Product not found');
    }
    res.json(presentProduct(product, await remainingStock(product.id)));
  })
);

module.exports = router;
