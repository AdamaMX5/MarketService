# MarketService

D2C-Marktplatz für WavyMania: Produktkatalog, Wave-gekoppelte Drops (auch limitierte
Flash-Drops), Bestellungen mit Versand-Lifecycle und atomarer Bestandsreservierung.

## Architecture
See @./MarketService.md für die eigene API Dokumentation (Datenmodelle, Redis-Bestandsführung, Kauf-Flow).
See @../../.claude/MSArchitecture/AuthService.md für AuthService details (JWT verification, GITCLIENT role).
See @../PaymentService/PaymentService.md für PaymentService details (Checkout-Sessions, Refunds).
See @../../.claude/MSArchitecture/EmailService.md für EmailService details (Bestätigungsmail nach Kauf).
See @../WaveService/WaveService.md für WaveService details (Stats-Update bei Wave-gekoppeltem Drop).
See @../../.claude/MSArchitecture/ExceptionService.md für ExceptionService details (Sende Fehlerfälle).
