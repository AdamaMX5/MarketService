const express = require('express');
const { Product } = require('../models/Product');
const { requireAuth, requireRoles, hasRole } = require('../middleware/auth');
const { asyncHandler, ApiError } = require('../middleware/errorHandler');
const { validateProductCreate, validateProductPatch } = require('../lib/productValidation');
const { getMerchantAccount } = require('../services/paymentServiceClient');
const { initStock, remainingStock } = require('../lib/stock');
const { presentProduct } = require('../lib/presenters');

const router = express.Router();

const MERCHANT_ROLES = ['merchant', 'creator'];

function isOwnerOrAdmin(user, product) {
  return user.id === product.merchantId || hasRole(user, 'admin');
}

async function loadOwnedProduct(id, user) {
  const product = await Product.findByIdSafe(id);
  if (!product) throw ApiError.notFound('Product not found');
  if (!isOwnerOrAdmin(user, product)) throw ApiError.forbidden('Not your product');
  return product;
}

router.post(
  '/products',
  requireAuth,
  requireRoles(...MERCHANT_ROLES),
  asyncHandler(async (req, res) => {
    const data = validateProductCreate(req.body);
    const product = await Product.create({ ...data, merchantId: req.user.id, state: 'draft' });
    res.status(201).json(presentProduct(product, null));
  })
);

router.patch(
  '/products/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const product = await loadOwnedProduct(req.params.id, req.user);
    const update = validateProductPatch(product, req.body);
    Object.assign(product, update);
    await product.save();
    res.json(presentProduct(product, await remainingStock(product.id)));
  })
);

router.post(
  '/products/:id/publish',
  requireAuth,
  asyncHandler(async (req, res) => {
    const product = await loadOwnedProduct(req.params.id, req.user);
    if (product.state !== 'draft') throw ApiError.conflict('Only draft products can be published');

    // Forwards the merchant's own Bearer JWT — no extra internal endpoint needed on
    // the PaymentService side to read their own onboarding state.
    const account = await getMerchantAccount(req.bearerToken);
    if (account.onboardingState !== 'complete') {
      throw ApiError.conflict('PaymentService merchant onboarding is not complete');
    }

    // Stock is initialized before the state flip is persisted: if Redis is down, the
    // product stays `draft` (initialStock still editable, publish can be retried)
    // instead of becoming an immutable `published` product with no stock key.
    await initStock(product.id, product.initialStock);
    product.state = 'published';
    await product.save();
    res.json(presentProduct(product, product.initialStock));
  })
);

module.exports = router;
