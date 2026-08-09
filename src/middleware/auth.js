const jwt = require('jsonwebtoken');
const { getPublicKey } = require('../services/authKey');

function decodeBearer(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

function verify(token) {
  return jwt.verify(token, getPublicKey(), { algorithms: ['RS256'] });
}

function toUser(payload) {
  if (!payload || typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('JWT payload missing sub');
  }
  return {
    id: payload.sub,
    email: payload.email,
    roles: Array.isArray(payload.roles) ? payload.roles : [],
    permissions: payload.permissions || {},
  };
}

/** Requires a valid Bearer JWT; 401 otherwise. */
function requireAuth(req, res, next) {
  const token = decodeBearer(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  try {
    req.user = toUser(verify(token));
    req.bearerToken = token;
    return next();
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Attaches req.user if a valid JWT is present, but never rejects the request. */
function optionalAuth(req, _res, next) {
  const token = decodeBearer(req);
  if (!token) return next();
  try {
    req.user = toUser(verify(token));
    req.bearerToken = token;
  } catch (_err) {
    // Discovery endpoints stay reachable even with a stale/invalid token.
  }
  return next();
}

function hasRole(user, role) {
  return user.roles.some((r) => String(r).toUpperCase() === role.toUpperCase());
}

/** Must be used after requireAuth. 403 if the user has none of the given roles. */
function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.some((role) => hasRole(req.user, role))) {
      return res.status(403).json({ error: 'Insufficient role' });
    }
    return next();
  };
}

module.exports = { requireAuth, optionalAuth, requireRoles, hasRole };
