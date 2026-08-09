const mongoose = require('mongoose');
const serialize = require('./plugins/serialize');

const STATES = ['draft', 'published', 'soldout', 'archived'];
const CURRENCIES = ['eur'];

const productSchema = new mongoose.Schema(
  {
    merchantId: { type: String, required: true, index: true },
    waveId: { type: String, default: null, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 5000 },
    mediaIds: { type: [String], default: [] },
    priceCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    currency: { type: String, required: true, enum: CURRENCIES, default: 'eur' },
    initialStock: { type: Number, required: true, min: 0, validate: Number.isInteger },
    maxPerUser: { type: Number, default: 2, min: 1, validate: Number.isInteger },
    dropAt: { type: Date, default: null },
    state: { type: String, required: true, enum: STATES, default: 'draft', index: true },
    requiresShipping: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ state: 1, merchantId: 1 });
productSchema.index({ state: 1, waveId: 1 });

/** Like findById, but an invalid ObjectId format resolves to null instead of throwing. */
productSchema.statics.findByIdSafe = async function findByIdSafe(id) {
  try {
    return await this.findById(id);
  } catch (err) {
    if (err.name === 'CastError') return null;
    throw err;
  }
};

serialize(productSchema);

module.exports = {
  Product: mongoose.model('Product', productSchema),
  STATES,
  CURRENCIES,
};
