const cron = require('node-cron');
const { Order } = require('../models/Order');
const { releaseHold } = require('../lib/orderTransitions');
const { reportException } = require('../services/exceptionServiceClient');

// Reuses the same guarded transition as the PaymentService "expired" callback, so
// whichever of the two arrives first releases the stock exactly once.
async function expireHolds(now = new Date()) {
  const expired = await Order.find({ state: 'pendingPayment', reservedUntil: { $lt: now } });
  let released = 0;
  for (const order of expired) {
    if (await releaseHold(order)) released += 1;
  }
  return released;
}

function startExpireHoldsJob() {
  return cron.schedule('* * * * *', () => {
    expireHolds().catch((error) => {
      reportException({ message: `expireHolds job failed: ${error.message}`, stack: error.stack });
    });
  });
}

module.exports = { expireHolds, startExpireHoldsJob };
