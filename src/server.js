require('dotenv').config();

const env = require('./config/env');
const { createApp } = require('./app');
const { connectMongo } = require('./db/mongoose');
const { getRedis } = require('./db/redis');
const { loadPublicKey } = require('./services/authKey');
const { startExpireHoldsJob } = require('./jobs/expireHolds');

async function main() {
  await loadPublicKey();
  await connectMongo();
  getRedis();

  const app = createApp();
  app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`MarketService listening on port ${env.PORT}`);
  });

  startExpireHoldsJob();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('MarketService failed to start:', err);
  process.exit(1);
});
