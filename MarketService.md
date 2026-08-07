# MarketService

> Base URL: `https://market.<wavy-domain>` · Phase 3

**D2C-Marktplatz:** Produktkatalog der Brands/Creator, Wave-gekoppelte Drops (auch limitierte
Flash-Drops), Bestellungen mit Versand-Lifecycle. Zahlungen laufen komplett über den
**PaymentService**. Kern-Schwierigkeit ist die **atomare Bestandsreservierung** unter Last
(500 Stück, 20.000 Interessenten im selben Moment) — deshalb liegt der verkaufbare Bestand
in Redis, MongoDB hält nur den Katalog- und Bestell-Zustand.

**Datenmodell `Product`:**

| Feld | Typ | Description |
|------|-----|-------------|
| `id` | String | Dokument-ID |
| `merchantId` | String | JWT `sub` (Rolle `merchant`/`creator`) |
| `waveId` | String | optional — Drop an eine Wave gekoppelt |
| `title` / `description` | String | max. 120 / 5.000 Zeichen |
| `mediaIds` | String[] | MediaService |
| `priceCents` / `currency` | Number/String | vorerst nur `eur` |
| `initialStock` | Number | Gesamtauflage; danach unveränderlich (Limited-Drop-Versprechen) |
| `maxPerUser` | Number | default 2 |
| `dropAt` | Date | optional — vor diesem Zeitpunkt sichtbar, aber nicht kaufbar (`409`) |
| `state` | String | Enum: `draft`, `published`, `soldout`, `archived` |
| `requiresShipping` | Boolean | `false` für digitale Güter (dann kein Adress-Zwang) |
| `createdAt` / `updatedAt` | Date | Auto |

**Datenmodell `Order`:**

| Feld | Typ | Description |
|------|-----|-------------|
| `id` | String | Dokument-ID |
| `userId` / `merchantId` / `productId` | String | Referenzen (eine Order = ein Produkt; Warenkorb bewusst out of scope — Drops sind Einzelkäufe) |
| `quantity` | Number | ≤ `maxPerUser` (kumulativ über alle Orders des Users für dieses Produkt) |
| `amountCents` | Number | `quantity × priceCents` zum Kaufzeitpunkt (Preisänderungen wirken nicht rückwirkend) |
| `state` | String | Enum: `pendingPayment`, `paid`, `shipped`, `delivered`, `cancelled`, `refunded` |
| `paymentRef` | String | PaymentService-Session-ID |
| `shippingAddress` | Object | `{ name, street, zip, city, country }` — Pflicht wenn `requiresShipping` |
| `trackingRef` | String | optional, vom Merchant gesetzt |
| `reservedUntil` | Date | 5 min Hold; Cron gibt abgelaufene `pendingPayment`-Bestände frei |
| `createdAt` / `updatedAt` | Date | Auto |

**Bestandsführung (Redis, atomar):**

| Key | Inhalt |
|-----|--------|
| `stock:{productId}` | verbleibender Bestand; beim Publish auf `initialStock` gesetzt |
| `bought:{productId}:{userId}` | kumulierte Menge für `maxPerUser`-Check |

Kauf-Start als **Lua-Script** (ein Roundtrip, keine Race Condition): prüft `maxPerUser`,
dekrementiert `stock` um `quantity`; Ergebnis < 0 → Rollback + `409 soldout`. Bei
Reservierungs-Ablauf oder `expired`/`refunded`: `INCRBY` zurück. Erreicht `stock` 0 und
keine offenen Holds mehr → Produkt-State `soldout`.

**Kauf-Flow:** identisch zum TicketService-Muster —
`POST /products/:id/orders` → Hold + PaymentService-Session → `{ orderId, checkoutUrl }` →
`paid`-Callback auf `/internal/payment-events` (idempotent) → Bestätigungs-Mail via EmailService,
bei `waveId` Stats-Event an den WaveService.

---

## Public

| Method | Endpoint | Query | Description |
|--------|----------|-------|-------------|
| `GET` | `/products` | `?state=published&merchantId&waveId&page&limit` | Katalog; liefert `remainingStock` (aus Redis) mit |
| `GET` | `/products/:id` | — | Produkt-Detail |

## User (Bearer JWT)

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `POST` | `/products/:id/orders` | `{ quantity*, shippingAddress? }` | Kauf starten → `{ orderId, checkoutUrl }`. Vor `dropAt` → `409`; ausverkauft → `409`; über `maxPerUser` → `409` |
| `GET` | `/me/orders` | `?page&limit` | Eigene Bestellungen |
| `GET` | `/me/orders/:id` | — | Detail inkl. Tracking |

## Merchant (Bearer JWT, Rolle `merchant`/`creator`; nur eigene Produkte/Orders, sonst `403`)

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `POST` | `/products` | Produkt-Felder | Anlegen als `draft` → `201` |
| `PATCH` | `/products/:id` | änderbare Felder | `draft`: alles; `published`: nur `description`, `mediaIds`, `state→archived`. `initialStock` nach Publish unveränderlich → `400` |
| `POST` | `/products/:id/publish` | — | `draft → published`; setzt Redis-Stock; PaymentService-Onboarding muss `complete` sein → sonst `409` |
| `GET` | `/orders` | `?productId&state&page&limit` | Eingehende Bestellungen |
| `POST` | `/orders/:id/ship` | `{ trackingRef? }` | `paid → shipped` |
| `POST` | `/orders/:id/refund` | — | Refund via PaymentService → `202`; State-Wechsel kommt per Callback |

## Internal (X-API-Key)

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `POST` | `/internal/payment-events` | `{ sessionId, sourceId, event }` | Callback vom PaymentService (idempotent) |
| `GET` | `/internal/products/:id` | — | Für WaveService-Verknüpfungsanzeige |

---

## Env (zusätzlich zur Basis)

```
REDIS_URL
PAYMENT_SERVICE_URL / PAYMENT_SERVICE_API_KEY
EMAIL_SERVICE_URL / EMAIL_SERVICE_API_KEY
WAVE_SERVICE_URL / WAVE_SERVICE_API_KEY
ORDER_HOLD_TTL_MIN=5
```

## Akzeptanzkriterien (Test-Experte)

1. **Lasttest-Kern:** 50 parallele Orders à 1 Stück auf ein Produkt mit `initialStock: 10` →
   genau 10 × `pendingPayment`, 40 × `409`; Redis-Stock endet bei 0, nie negativ
2. Abgelaufener Hold gibt den Bestand frei; ein danach startender Kauf bekommt ihn
3. `maxPerUser: 2`: dritter Kauf desselben Users (auch über zwei Orders verteilt) → `409`
4. Kauf vor `dropAt` → `409`; exakt ab `dropAt` möglich
5. `refunded`-Callback inkrementiert den Bestand und setzt Order-State (idempotent bei Doppel-Event)
6. `initialStock`-PATCH nach Publish → `400`
