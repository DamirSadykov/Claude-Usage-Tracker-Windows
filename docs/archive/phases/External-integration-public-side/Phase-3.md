# Phase 3: Resolver MVP
<!-- status: done -->

Каркас resolver: ingest-auth, mailbox, poll с проверкой подписи, доставка account→devices

- [x] 3.1 Каркас сервиса (Rust+axum, крейт в репо)
- [x] 3.2 Ingest-endpoint: конверт + ingest-токен (per-source, 401) → mailbox
- [x] 3.3 Poll-endpoint: проверка подписи устройства → выдача недоставленного
- [x] 3.4 Маппинг account→devices + доставка веером
