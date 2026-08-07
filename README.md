# MarketService

**D2C marketplace** for WavyMania: brand/creator product catalog, wave-coupled drops (including
limited flash drops), and orders with a shipping lifecycle. Payments run entirely through the
PaymentService. The core challenge is **atomic stock reservation** under load (500 units, 20,000
interested buyers at once) -- sellable stock lives in Redis, MongoDB only holds catalog and order
state.

## Stack

- Node.js + Express
- MongoDB via Mongoose, Redis for atomic stock reservation (Lua scripts)
- JWT (RS256) verification against the AuthService public key
- `X-API-Key` auth for internal service-to-service calls

## Documentation

The full specification -- data models, endpoints, env variables, and acceptance criteria -- lives
in [MarketService.md](./MarketService.md).

Part of the [WavyMania](https://github.com/AdamaMX5/WavyMania) microservice ecosystem.
