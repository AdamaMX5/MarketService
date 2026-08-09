const { reportException } = require('../services/exceptionServiceClient');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

class ApiError extends Error {
  constructor(statusCode, message, publicMessage) {
    super(message);
    this.statusCode = statusCode;
    this.publicMessage = publicMessage || message;
  }

  static badRequest(message) {
    return new ApiError(400, message);
  }

  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, message);
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError(403, message);
  }

  static notFound(message = 'Not found') {
    return new ApiError(404, message);
  }

  static conflict(message) {
    return new ApiError(409, message);
  }

  static badGateway(message = 'Upstream service unavailable') {
    return new ApiError(502, message);
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;

  if (statusCode >= 500) {
    reportException({
      message: err.message,
      stack: err.stack,
      statusCode,
      method: req.method,
      path: req.originalUrl,
    });
  }

  const publicMessage =
    statusCode >= 500 ? 'Internal server error' : err.publicMessage || err.message || 'Request failed';
  res.status(statusCode).json({ error: publicMessage });
}

module.exports = { asyncHandler, errorHandler, ApiError };
