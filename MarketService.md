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
| `GET` | `/me/products` | `?state&page&limit` | Eigene Produkte über **alle** States (anders als `GET /products`, das Fremden nur `published`/`soldout` zeigt) — für die Katalogverwaltung im Draft-Zustand |
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

## PaymentService (extern) — vom MarketService aufgerufen

Implementiert unter [../PaymentService/PaymentService.md](../PaymentService/PaymentService.md).
MarketService ist Caller mit dem Key `INTERNAL_API_KEY_MARKET_SERVICE` (dort so benannt).

| Method | Endpoint | Auth | Von wo | Zweck |
|--------|----------|------|--------|-------|
| `POST` | `/internal/sessions` | `X-API-Key` (`PAYMENT_SERVICE_API_KEY`) | `POST /products/:id/orders` | Checkout-Session für die Order → `{ sessionId, checkoutUrl }`. Merchant-Onboarding unvollständig → `409` |
| `POST` | `/internal/refunds` | `X-API-Key` | `POST /orders/:id/refund` | Stößt den Refund bei Stripe an → `202`; State-Wechsel auf `refunded` kommt per Callback auf `/internal/payment-events` |
| `GET` | `/accounts/me` | Bearer JWT (**des Merchants**, durchgereicht) | `POST /products/:id/publish` | `{ onboardingState, payoutsEnabled }` — Publish-Gate; kein separater interner Endpunkt nötig, da MarketService das JWT des aufrufenden Merchants 1:1 weiterreicht |

---

## Env (zusätzlich zur Basis)

```
REDIS_URL
PAYMENT_SERVICE_URL / PAYMENT_SERVICE_API_KEY
EMAIL_SERVICE_URL / EMAIL_SERVICE_API_KEY
WAVE_SERVICE_URL / WAVE_SERVICE_API_KEY
ORDER_HOLD_TTL_MIN=5
PLATFORM_FEE_BPS=500   # feeCents-Berechnung für PaymentService-Checkout-Sessions (implementierungsintern)
```

## Akzeptanzkriterien (Test-Experte)

1. **Lasttest-Kern:** 50 parallele Orders à 1 Stück auf ein Produkt mit `initialStock: 10` →
   genau 10 × `pendingPayment`, 40 × `409`; Redis-Stock endet bei 0, nie negativ
2. Abgelaufener Hold gibt den Bestand frei; ein danach startender Kauf bekommt ihn
3. `maxPerUser: 2`: dritter Kauf desselben Users (auch über zwei Orders verteilt) → `409`
4. Kauf vor `dropAt` → `409`; exakt ab `dropAt` möglich
5. `refunded`-Callback inkrementiert den Bestand und setzt Order-State (idempotent bei Doppel-Event)
6. `initialStock`-PATCH nach Publish → `400`

---

## Implementierungsdetails

Umgesetzt in Node.js + Express + Mongoose + ioredis (`src/`), Struktur analog zu WaveService und
TicketService — Lua-Scripts statt Mongo-`findOneAndUpdate` für die Bestandsreservierung, da der
Lastfall (500 Stück, 20.000 gleichzeitige Interessenten) einen einzelnen Redis-Roundtrip ohne
Dokument-Contention braucht. Siehe [README.md](./README.md) für Setup.

- **Fehlerformat:** `{ "error": "<message>" }`; `400` Validierung (inkl. unbekannter/nicht
  editierbarer Felder, Steuerzeichen in `title`/`trackingRef`/`description`, ungültige
  `waveId`-Form), `401` fehlender/ungültiger Token, API-Key oder JWT ohne `sub`, `403` falsche
  Rolle/nicht Eigentümer, `404` nicht gefunden (inkl. `draft`/`archived` für Fremde — wird als
  `404`, nicht `403`, maskiert, um die Existenz nicht zu leaken), `409` Zustandskonflikt
  (Publish vor abgeschlossenem Onboarding, Kauf vor `dropAt`, ausverkauft, `maxPerUser`
  überschritten, ungültiger Order-/Product-Übergang), `500`-Interna nie im Response-Body, nur an
  den ExceptionService.
- **Redis-Bestandsführung** (`src/lib/stock.js`): `stock:{productId}` (verbleibender Bestand) und
  `bought:{productId}:{userId}` (kumulierte Menge für `maxPerUser`) werden über zwei Lua-Scripts
  angefasst. `reserveStock` prüft `maxPerUser` und dekrementiert `stock` in einem Roundtrip; ein
  negatives Zwischenergebnis wird vor der Rückgabe zurückgerollt, sodass der Key nie negativ
  bleibt — auch nicht transient. Die Freigabe ist bewusst in zwei Varianten gesplittet:
  `releaseHoldStock` (Hold-Ablauf / abgebrochener Checkout) gibt sowohl `stock` als auch `bought`
  zurück, `releaseRefundStock` (Merchant-Refund) gibt **nur** `stock` zurück — sonst könnte ein
  Käufer bei einem limitierten Drop kaufen, sich erstatten lassen und dieselbe
  `maxPerUser`-Menge erneut kaufen ("Refund-Farming"). Erreicht `stock` beim Reservieren exakt
  `0`, wird das Produkt best-effort auf `soldout` gesetzt; wird bei einer Freigabe wieder > 0,
  auf `published` zurückgesetzt. Die Katalog-Liste (`GET /products`) holt den Bestand aller
  Treffer einer Seite über ein einziges `MGET` statt N Einzel-`GET`s.
- **Order-Zustandsmaschine:** Enum wie oben dokumentiert; es gibt keinen separaten
  `expired`-Wert — sowohl ein per Cron abgelaufener Hold als auch ein PaymentService-
  `expired`-Webhook wechseln über denselben guarded `findOneAndUpdate`-Gate
  (`src/lib/orderTransitions.js`) nach `cancelled`. Das macht Webhook und Cron gegenseitig
  idempotent (wer zuerst kommt, gewinnt). `refunded` ist von `paid`, `shipped` und `delivered`
  aus erreichbar — dieselbe Liste steuert sowohl den Merchant-Endpunkt (`POST
  /orders/:id/refund`, der nur den Refund bei PaymentService anstößt) als auch den
  Webhook-Handler (der tatsächlich nach `refunded` wechselt), damit ein von PaymentService
  verarbeiteter Refund nie an einer stillen Zustands-Fehlanpassung scheitert. Ein
  `paid`-Callback, der auf eine Order trifft, die nicht mehr `pendingPayment` ist (die
  Checkout-Session kann den 5-Minuten-Hold überleben), wird nicht stillschweigend verworfen,
  sondern an den ExceptionService gemeldet — das ist eingezogenes Geld ohne gültige Order.
- **Public-Discovery-Whitelist:** `GET /products` und `GET /products/:id` zeigen
  Nicht-Eigentümern nur `published`/`soldout`; `draft`/`archived` werden als `404` maskiert
  (analog WaveService). Ein `state`-Query-Parameter außerhalb dieser Liste → `400`.
- **NoSQL-Injection-Schutz:** `app.set('query parser', 'simple')` verhindert, dass der
  Default-`qs`-Parser aus `?merchantId[$ne]=x` ein verschachteltes Objekt macht, das sonst
  direkt als Mongo-Operator in einem Filter landen würde; zusätzlich akzeptieren alle
  Query-gespeisten Mongo-Filter (`merchantId`, `waveId`, `productId`, `state`) nur einzelne
  String-Werte (`src/lib/queryString.js`).
- **Internal-Auth:** folgt der AuthService-Konvention — ein `X-API-Key` pro Caller über
  `INTERNAL_API_KEY_<SERVICENAME>`, konstant-zeitiger Vergleich, kein geteilter Master-Key.
  `POST /internal/payment-events` akzeptiert ausschließlich den Caller `PAYMENT_SERVICE` — jeder
  andere gültige interne Key bekommt `403` (kein anderer Service darf Order-Zustände flippen).
  `waveId` wird bei Produkt-Erstellung/-Änderung als Mongo-ObjectId-Form validiert und beim
  ausgehenden WaveService-Call zusätzlich `encodeURIComponent`-kodiert, bevor er mit dem
  privilegierten `WAVE_SERVICE_API_KEY` in den Pfad eingesetzt wird.
- **WaveService-Stats-Integration:** `src/services/waveServiceClient.js` feuert bei einem
  bezahlten, Wave-gekoppelten Drop `POST /internal/waves/:id/stats` mit `field: "purchases"`.
  WaveService selbst erlaubt an diesem Endpunkt aktuell nur `field: "checkins"` (siehe dessen
  eigene Implementierungsdetails) — es gibt noch kein `purchases`-Feld im Wave-Stats-Schema. Der
  Aufruf ist fire-and-forget und blockiert nie den Kauf-Flow; bis WaveService ein passendes Feld
  ergänzt, wird dieser Call erwartungsgemäß abgelehnt.
- **Bestätigungsmail:** `buyerEmail` (aus dem JWT des Käufers zum Kaufzeitpunkt) ist ein
  Implementierungsdetail, kein oben dokumentiertes Order-Feld — der Payment-Callback trägt
  keinen Nutzerkontext, daher wird die Adresse beim Checkout auf der Order gespeichert.
- **Tests:** `tests/unit/**` (Redis-Lua-Scripts über `ioredis-mock`) und `tests/integration/**`
  (End-to-End über `supertest` + `mongodb-memory-server` + `ioredis-mock`, deckt alle 6
  Akzeptanzkriterien sowie die im Security-Audit gefundenen Regressionsfälle ab: NoSQL-
  Operator-Query, ungültige `waveId`, Steuerzeichen in `title`, JWT ohne `sub`).
