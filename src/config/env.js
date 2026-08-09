const REQUIRED_IN_PRODUCTION = ['MONGODB_URI', 'REDIS_URL', 'AUTH_SERVICE_URL', 'PAYMENT_SERVICE_URL'];

function readInt(name, fallback) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readEnv() {
  const env = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: readInt('PORT', 3000),
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/market-service',
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

    AUTH_SERVICE_URL: process.env.AUTH_SERVICE_URL || 'https://auth.freischule.info',
    AUTH_JWT_PUBLIC_KEY: process.env.AUTH_JWT_PUBLIC_KEY || null,

    PAYMENT_SERVICE_URL: process.env.PAYMENT_SERVICE_URL || 'https://payment.freischule.info',
    PAYMENT_SERVICE_API_KEY: process.env.PAYMENT_SERVICE_API_KEY || '',
    PLATFORM_FEE_BPS: readInt('PLATFORM_FEE_BPS', 500),

    EMAIL_SERVICE_URL: process.env.EMAIL_SERVICE_URL || 'https://email.freischule.info',
    EMAIL_SERVICE_API_KEY: process.env.EMAIL_SERVICE_API_KEY || '',

    WAVE_SERVICE_URL: process.env.WAVE_SERVICE_URL || 'https://wave.freischule.info',
    WAVE_SERVICE_API_KEY: process.env.WAVE_SERVICE_API_KEY || '',

    EXCEPTION_SERVICE_URL: process.env.EXCEPTION_SERVICE_URL || 'https://exception.freischule.info',
    EXCEPTION_SERVICE_API_KEY: process.env.EXCEPTION_SERVICE_API_KEY || '',

    ORDER_HOLD_TTL_MIN: readInt('ORDER_HOLD_TTL_MIN', 5),
    APP_BASE_URL: process.env.APP_BASE_URL || 'https://app.wavymania.io',
  };

  // One INTERNAL_API_KEY_<SERVICENAME> env var per allowed caller, mirroring the
  // AuthService internal-key convention — never a shared master key.
  env.internalApiKeys = new Map();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('INTERNAL_API_KEY_') && value) {
      env.internalApiKeys.set(key.slice('INTERNAL_API_KEY_'.length), value);
    }
  }

  if (env.NODE_ENV === 'production') {
    const missing = REQUIRED_IN_PRODUCTION.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`Missing required env vars in production: ${missing.join(', ')}`);
    }
  }

  return env;
}

module.exports = readEnv();
