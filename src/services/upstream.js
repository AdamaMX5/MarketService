const axios = require('axios');
const { ApiError } = require('../middleware/errorHandler');

const DEFAULT_TIMEOUT_MS = 10000;

function createClient(baseURL, headers = {}) {
  return axios.create({ baseURL, headers, timeout: DEFAULT_TIMEOUT_MS });
}

// Upstream clients are built on first use, not at require time, so the process can
// boot before every service URL is resolvable (and tests can stub env vars first).
function lazyClient(factory) {
  let client = null;
  return () => (client ??= factory());
}

// Upstream failures become 502 by default; only statuses a route contractually
// re-exposes are passed through unchanged.
function propagate(error, service, passthroughStatuses = []) {
  const status = error.response?.status;
  if (status && passthroughStatuses.includes(status)) {
    const message = error.response?.data?.error;
    throw new ApiError(status, message || `${service} rejected the request`);
  }
  throw ApiError.badGateway(`${service} request failed`);
}

module.exports = { createClient, lazyClient, propagate };
