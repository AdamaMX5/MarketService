const express = require('express');
const publicProducts = require('./routes/publicProducts');
const userOrders = require('./routes/userOrders');
const merchantProducts = require('./routes/merchantProducts');
const merchantOrders = require('./routes/merchantOrders');
const internalRouter = require('./routes/internal');
const { errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Express defaults to the `qs` parser, which turns `?merchantId[$ne]=x` into a
  // nested object — that object would otherwise flow straight into a Mongoose
  // filter as a Mongo operator. The `simple` (querystring) parser never nests, so
  // every query value is always a plain string.
  app.set('query parser', 'simple');
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'MarketService' }));

  // CORS is handled centrally at the NGINX layer, not here.
  app.use(publicProducts);
  app.use(userOrders);
  app.use(merchantProducts);
  app.use(merchantOrders);
  app.use(internalRouter);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
