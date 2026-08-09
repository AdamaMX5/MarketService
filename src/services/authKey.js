const axios = require('axios');
const env = require('../config/env');

let cachedPublicKey = env.AUTH_JWT_PUBLIC_KEY;

async function loadPublicKey({ retries = 5, delayMs = 2000 } = {}) {
  if (cachedPublicKey) return cachedPublicKey;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const { data } = await axios.get(`${env.AUTH_SERVICE_URL}/jwt/public-key`, { timeout: 5000 });
      if (!data || !data.public_key) {
        throw new Error('AuthService response missing public_key');
      }
      cachedPublicKey = data.public_key;
      return cachedPublicKey;
    } catch (err) {
      if (attempt === retries) {
        throw new Error(`Failed to load AuthService public key after ${retries} attempts: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return cachedPublicKey;
}

function getPublicKey() {
  if (!cachedPublicKey) {
    throw new Error('AuthService public key not loaded yet');
  }
  return cachedPublicKey;
}

function setPublicKey(pem) {
  cachedPublicKey = pem;
}

module.exports = { loadPublicKey, getPublicKey, setPublicKey };
