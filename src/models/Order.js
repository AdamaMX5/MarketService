const mongoose = require('mongoose');
const serialize = require('./plugins/serialize');

const STATES = ['pendingPayment', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'];

const shippingAddressSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    street: { type: String, required: true, trim: true, maxlength: 200 },
    zip: { type: String, required: true, trim: true, maxlength: 20 },
    city: { type: String, required: true, trim: true, maxlength: 120 },
    country: { type: String, required: true, trim: true, maxlength: 2 },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    merchantId: { type: String, required: true, index: true },
    productId: { type: String, required: true, index: true },
    quantity: { type: Number, required: true, min: 1, validate: Number.isInteger },
    amountCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    state: { type: String, required: true, enum: STATES, default: 'pendingPayment', index: true },
    paymentRef: { type: String, default: null, index: true },
    shippingAddress: { type: shippingAddressSchema, default: null },
    trackingRef: { type: String, default: null, maxlength: 200 },
    reservedUntil: { type: Date, default: null, index: true },
    // Set once a merchant-triggered refund has been requested from PaymentService, so a
    // retried /orders/:id/refund call can never fire two refund requests for one order.
    refundRequestedAt: { type: Date, default: null },
    // Captured at checkout time (the payment callback carries no user context) so the
    // paid-confirmation mail can be sent from the async webhook handler.
    buyerEmail: { type: String, default: null },
  },
  { timestamps: true }
);

orderSchema.index({ state: 1, reservedUntil: 1 });
orderSchema.index({ productId: 1, userId: 1 });

/** Like findById, but an invalid ObjectId format resolves to null instead of throwing. */
orderSchema.statics.findByIdSafe = async function findByIdSafe(id) {
  try {
    return await this.findById(id);
  } catch (err) {
    if (err.name === 'CastError') return null;
    throw err;
  }
};

serialize(orderSchema);

module.exports = {
  Order: mongoose.model('Order', orderSchema),
  STATES,
};
