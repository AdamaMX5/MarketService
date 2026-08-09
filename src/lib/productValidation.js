const { ApiError } = require('../middleware/errorHandler');
const { CURRENCIES } = require('../models/Product');

// C0/C1 control characters (incl. CR/LF) — rejected in any field that ends up in an
// email subject or a header-adjacent context, so a title/tracking value can never
// inject extra header lines downstream.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
// WaveService ids are Mongo ObjectIds; enforcing the shape here means a merchant-
// supplied waveId can never carry path segments (e.g. "../") into the internal
// WaveService call made with WAVE_SERVICE_API_KEY (see waveServiceClient.js).
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

const CREATABLE_FIELDS = [
  'title',
  'description',
  'mediaIds',
  'priceCents',
  'currency',
  'initialStock',
  'maxPerUser',
  'dropAt',
  'requiresShipping',
  'waveId',
];
const PUBLISHED_PATCHABLE_FIELDS = ['description', 'mediaIds', 'state'];

function assertNoUnknownFields(body, allowed) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw ApiError.badRequest(`Unknown or non-editable field(s): ${unknown.join(', ')}`);
  }
}

// `partial: true` skips the required-ness check (used for PATCH) but still validates
// type/shape whenever the field is present.
function validateCommonFields(data, { partial = false } = {}) {
  if (!partial || data.title !== undefined) {
    if (
      typeof data.title !== 'string' ||
      !data.title.trim() ||
      data.title.length > 120 ||
      CONTROL_CHARS.test(data.title)
    ) {
      throw ApiError.badRequest('title is required, at most 120 characters, and must not contain control characters');
    }
  }
  if (data.description !== undefined) {
    if (
      typeof data.description !== 'string' ||
      data.description.length > 5000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data.description) // tabs/newlines are fine in free text
    ) {
      throw ApiError.badRequest('description must be a plain-text string of at most 5000 characters');
    }
  }
  if (data.mediaIds !== undefined) {
    if (
      !Array.isArray(data.mediaIds) ||
      data.mediaIds.length > 20 ||
      !data.mediaIds.every((m) => typeof m === 'string' && m.length <= 200 && !CONTROL_CHARS.test(m))
    ) {
      throw ApiError.badRequest('mediaIds must be an array of at most 20 strings (max 200 chars each)');
    }
  }
  if (!partial || data.priceCents !== undefined) {
    if (!Number.isInteger(data.priceCents) || data.priceCents < 0) {
      throw ApiError.badRequest('priceCents is required and must be a non-negative integer');
    }
  }
  if (data.currency !== undefined && !CURRENCIES.includes(data.currency)) {
    throw ApiError.badRequest(`currency must be one of: ${CURRENCIES.join(', ')}`);
  }
  if (!partial || data.initialStock !== undefined) {
    if (!Number.isInteger(data.initialStock) || data.initialStock < 0) {
      throw ApiError.badRequest('initialStock is required and must be a non-negative integer');
    }
  }
  if (data.maxPerUser !== undefined) {
    if (!Number.isInteger(data.maxPerUser) || data.maxPerUser < 1) {
      throw ApiError.badRequest('maxPerUser must be a positive integer');
    }
  }
  if (data.dropAt !== undefined && data.dropAt !== null) {
    if (Number.isNaN(new Date(data.dropAt).getTime())) {
      throw ApiError.badRequest('dropAt must be a valid date');
    }
  }
  if (data.requiresShipping !== undefined && typeof data.requiresShipping !== 'boolean') {
    throw ApiError.badRequest('requiresShipping must be a boolean');
  }
  if (data.waveId !== undefined && data.waveId !== null && !OBJECT_ID_RE.test(data.waveId)) {
    throw ApiError.badRequest('waveId must be a valid WaveService id');
  }
}

function validateProductCreate(body) {
  const data = body || {};
  assertNoUnknownFields(data, CREATABLE_FIELDS);
  validateCommonFields(data);
  return {
    title: data.title.trim(),
    description: data.description || '',
    mediaIds: data.mediaIds || [],
    priceCents: data.priceCents,
    currency: data.currency || 'eur',
    initialStock: data.initialStock,
    maxPerUser: data.maxPerUser ?? 2,
    dropAt: data.dropAt ? new Date(data.dropAt) : null,
    requiresShipping: data.requiresShipping ?? true,
    waveId: data.waveId || null,
  };
}

function validateDraftPatch(data) {
  assertNoUnknownFields(data, CREATABLE_FIELDS);
  validateCommonFields(data, { partial: true });
  const update = { ...data };
  if (update.title !== undefined) update.title = update.title.trim();
  if (update.dropAt !== undefined) update.dropAt = update.dropAt ? new Date(update.dropAt) : null;
  return update;
}

function validatePublishedPatch(data) {
  if (Object.prototype.hasOwnProperty.call(data, 'initialStock')) {
    throw ApiError.badRequest('initialStock cannot be changed once a product is published');
  }
  if (data.state !== undefined && data.state !== 'archived') {
    throw ApiError.badRequest('A published product can only transition to archived');
  }
  assertNoUnknownFields(data, PUBLISHED_PATCHABLE_FIELDS);
  const contentFields = { ...data };
  delete contentFields.state;
  validateCommonFields(contentFields, { partial: true });
  return data.state === 'archived' ? { ...contentFields, state: 'archived' } : contentFields;
}

function validateProductPatch(product, body) {
  const data = body || {};
  if (product.state === 'draft') return validateDraftPatch(data);
  // soldout is treated like published (a merchant must still be able to archive a
  // drop that sold out, or tweak its description/media).
  if (product.state === 'published' || product.state === 'soldout') return validatePublishedPatch(data);
  throw ApiError.conflict(`A ${product.state} product can no longer be edited`);
}

module.exports = { validateProductCreate, validateProductPatch };
