const crypto = require('crypto');
const env = require('../config/env');

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a compare against a same-length buffer so early-exit timing doesn't leak length.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Requires X-API-Key matching one of the INTERNAL_API_KEY_<SERVICENAME> env vars.
 * On success sets req.callerService to the derived caller identity — never trusts a
 * caller-supplied identity header.
 */
function requireApiKey(req, res, next) {
  const presented = req.headers['x-api-key'];
  if (!presented) {
    return res.status(401).json({ error: 'Missing X-API-Key' });
  }

  for (const [serviceName, key] of env.internalApiKeys.entries()) {
    if (constantTimeEquals(presented, key)) {
      req.callerService = serviceName;
      return next();
    }
  }

  return res.status(401).json({ error: 'Invalid API key' });
}

module.exports = { requireApiKey };
