const env = require('../config/env');
const { createClient, lazyClient } = require('./upstream');
const { reportException } = require('./exceptionServiceClient');

const getClient = lazyClient(() =>
  createClient(env.EMAIL_SERVICE_URL, { 'X-API-Key': env.EMAIL_SERVICE_API_KEY })
);

// Queued delivery; a failure here is reported but never rolls back a paid order.
async function sendEmail({ to, subject, body, isHtml = true, type, metadata }) {
  try {
    const { data } = await getClient().post('/emails', { to, subject, body, isHtml, type, metadata });
    return data;
  } catch (error) {
    reportException({ message: `EmailService send failed: ${error.message}`, metadata: { type, to } });
    return null;
  }
}

module.exports = { sendEmail };
