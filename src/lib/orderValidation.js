const { ApiError } = require('../middleware/errorHandler');

const REQUIRED_ADDRESS_FIELDS = ['name', 'street', 'zip', 'city', 'country'];

function validateShippingAddress(addr) {
  if (!addr || typeof addr !== 'object') {
    throw ApiError.badRequest('shippingAddress is required for this product');
  }
  for (const field of REQUIRED_ADDRESS_FIELDS) {
    if (typeof addr[field] !== 'string' || !addr[field].trim()) {
      throw ApiError.badRequest(`shippingAddress.${field} is required`);
    }
  }
  return {
    name: addr.name.trim(),
    street: addr.street.trim(),
    zip: addr.zip.trim(),
    city: addr.city.trim(),
    country: addr.country.trim().toUpperCase(),
  };
}

function validateOrderCreate(product, body) {
  const data = body || {};
  if (!Number.isInteger(data.quantity) || data.quantity < 1) {
    throw ApiError.badRequest('quantity is required and must be a positive integer');
  }

  let shippingAddress = null;
  if (product.requiresShipping) {
    shippingAddress = validateShippingAddress(data.shippingAddress);
  } else if (data.shippingAddress !== undefined) {
    throw ApiError.badRequest('shippingAddress is not applicable for this product');
  }

  return { quantity: data.quantity, shippingAddress };
}

module.exports = { validateOrderCreate };
