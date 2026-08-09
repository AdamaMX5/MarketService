const axios = require('axios');
const env = require('../config/env');

/** Best-effort report to ExceptionService; never throws, never blocks the caller. */
function reportException({ message, stack, statusCode, method, path, metadata }) {
  if (!env.EXCEPTION_SERVICE_API_KEY) return;

  axios
    .post(
      `${env.EXCEPTION_SERVICE_URL}/report`,
      { service: 'MarketService', message, stack, statusCode, method, path, metadata },
      { headers: { 'X-API-Key': env.EXCEPTION_SERVICE_API_KEY }, timeout: 5000 }
    )
    .catch(() => {});
}

module.exports = { reportException };
