const env = require('../config/env');
const { createClient, lazyClient } = require('./upstream');
const { reportException } = require('./exceptionServiceClient');

const getClient = lazyClient(() =>
  createClient(env.WAVE_SERVICE_URL, { 'X-API-Key': env.WAVE_SERVICE_API_KEY })
);

// Fire-and-forget: a wave-coupled drop's stats update must never block or fail an order.
// waveId is validated as an ObjectId shape in productValidation.js, but the path
// segment is still encoded here as defense in depth against a caller-controlled
// value ever reaching this privileged (WAVE_SERVICE_API_KEY) request unescaped.
async function incrementWaveStats(waveId, field, delta) {
  if (!waveId) return;
  try {
    await getClient().post(`/internal/waves/${encodeURIComponent(waveId)}/stats`, { field, delta });
  } catch (error) {
    reportException({ message: `WaveService stats update failed: ${error.message}`, metadata: { waveId } });
  }
}

module.exports = { incrementWaveStats };
