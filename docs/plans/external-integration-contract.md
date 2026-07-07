# Контракт интеграции (Фаза 1)

Артефакт Фазы 1 плана `External-integration-public-side` (CC-task #77). Обе стороны —
приватный `external module` и публичный `resolver`/`instance` — кодят против этих схем.
Дизайн и обоснования: `external-integration.md`.

Нейтральность: никаких имён/полей конкретного сервиса. `source` — просто строка-метка.

## 1.1 Конверт (`external module → resolver`)

Resolver не читает `payload`, только маршрутизирует по `recipient`. Санитизация (вырезание
доступов из описаний) — на стороне `external module`, ДО отправки; сырое описание в конверт
не кладётся.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "external-integration/envelope.schema.json",
  "title": "Neutral event envelope (external module -> resolver)",
  "type": "object",
  "required": ["id", "ts", "recipient", "source", "type", "payload"],
  "additionalProperties": false,
  "properties": {
    "id":        { "type": "string", "minLength": 1,
                   "description": "Ключ идемпотентности/дедупликации, уникален в пределах source" },
    "ts":        { "type": "string", "format": "date-time",
                   "description": "Время события, RFC3339" },
    "recipient": { "type": "string", "format": "email",
                   "description": "Account-ключ; resolver разворачивает в устройства" },
    "source":    { "type": "string", "minLength": 1,
                   "description": "Метка источника (напр. \"svc-a\"); resolver не интерпретирует" },
    "type":      { "type": "string",
                   "enum": ["task_created", "task_status_changed", "task_moved", "task_comment_added"],
                   "description": "Форма события; конкретика перехода — в payload.status, не в type" },
    "payload":   { "$ref": "#/$defs/payload" }
  },
  "$defs": {
    "payload": {
      "type": "object",
      "description": "БЕЗ сырого описания задачи — санитизация на external module",
      "required": ["title", "status", "url", "updated_at"],
      "additionalProperties": false,
      "properties": {
        "title":      { "type": "string", "minLength": 1 },
        "status":     { "type": "string", "minLength": 1,
                        "description": "Статус в терминах источника; instance не хардкодит набор" },
        "priority":   { "type": "string", "enum": ["high", "medium", "low"] },
        "assignee":   { "type": "string" },
        "url":        { "type": "string", "format": "uri",
                        "description": "Ссылка на задачу в корп-сервисе (за авторизацией) — сюда за деталями" },
        "updated_at": { "type": "string", "format": "date-time" },
        "project":    { "type": "string", "minLength": 1,
                        "description": "Проект/воронка в терминах источника (напр. имя доски); опционально. Инстанс группирует задачи по нему, но не хардкодит набор" },
        "description": { "type": "string", "minLength": 1,
                        "description": "Описание задачи; опционально. Присутствует ТОЛЬКО если default-deny классификатор источника не нашёл признаков секретов (любое срабатывание → поле не кладётся целиком, частичной редакции нет); усечено на источнике" }
      }
    }
  }
}
```

**Закрыто (1.3):** `type` фиксирован — четыре формы события. Конкретика статус-перехода
(завершено/принято/отклонено/переоткрыто) не выносится в отдельные `type`, а живёт в
`payload.status` (инстанс не хардкодит набор статусов). Нормализация конкретного сервиса в эти
четыре имени — ответственность приватного `external module`.

## 1.2 Хранилище resolver'а

Resolver хранит только публичные ключи устройств (приватные не покидают instance) и mailbox
недоставленных/доставленных сообщений.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "external-integration/resolver-store.schema.json",
  "title": "Resolver persistent store",
  "type": "object",
  "required": ["accounts", "mailbox"],
  "additionalProperties": false,
  "properties": {
    "accounts": {
      "type": "object",
      "description": "account (email) -> список устройств",
      "additionalProperties": {
        "type": "array",
        "items": { "$ref": "#/$defs/device" }
      }
    },
    "mailbox": {
      "type": "array",
      "items": { "$ref": "#/$defs/message" }
    },
    "pending_codes": {
      "type": "array",
      "description": "Resolver-внутреннее состояние enrollment (приватная сторона этот store НЕ читает). Незарегистрированные ещё pairing-коды; хранится только hash. Необязательное поле — pre-enrollment store грузится без него.",
      "items": { "$ref": "#/$defs/pendingCode" }
    }
  },
  "$defs": {
    "device": {
      "type": "object",
      "required": ["device_id", "public_key", "enrolled_at"],
      "additionalProperties": false,
      "properties": {
        "device_id":   { "type": "string", "description": "Стабильный id устройства" },
        "public_key":  { "type": "string", "description": "Ed25519 public key, base64" },
        "enrolled_at": { "type": "string", "format": "date-time" },
        "last_seen":   { "type": "string", "format": "date-time" }
      }
    },
    "pendingCode": {
      "type": "object",
      "required": ["code_hash", "account"],
      "additionalProperties": false,
      "properties": {
        "code_hash":  { "type": "string", "description": "SHA-256(pairing code), hex. Сырой код не хранится." },
        "account":    { "type": "string", "format": "email" },
        "expires_at": { "type": ["string", "null"], "format": "date-time",
                        "description": "RFC3339 срок годности; null/отсутствует = ВЕЧНЫЙ (не протухает, не гасится при bind)." }
      }
    },
    "message": {
      "type": "object",
      "required": ["id", "recipient", "source", "type", "payload", "ts", "delivered_to"],
      "additionalProperties": false,
      "properties": {
        "id":         { "type": "string" },
        "recipient":  { "type": "string", "format": "email" },
        "source":     { "type": "string" },
        "type":       { "type": "string" },
        "payload":    { "type": "object", "description": "Копия payload из конверта, как есть" },
        "ts":         { "type": "string", "format": "date-time" },
        "delivered_to": {
          "type": "array",
          "items": { "type": "string" },
          "description": "device_id, которым сообщение уже отдано при поллинге"
        }
      }
    }
  }
}
```

**Доставка:** входящее сообщение с `recipient=email` кладётся в `mailbox`; каждое устройство
аккаунта при поллинге забирает сообщения, где его `device_id` ещё не в `delivered_to`, и
resolver дописывает его туда (доставка веером на все устройства аккаунта).

## Ingest-токены (не в store)

Токены `external module → resolver` — НЕ в этом хранилище, а в env/секрет-конфиге resolver'а,
ключ = `source`. Набор валидных токенов (для ротации без даунтайма). Проверка на ingest-endpoint:
`Authorization: Bearer …` по TLS, constant-time; нет/неверный/не тот source → 401. Детали — §4
дизайн-дока.

## Дедупликация

Ключ — **`(source, recipient, id)`**, НЕ `(source, id)`. Источник делает fan-out по получателям
(один конверт = одна пара «событие × получатель»), поэтому один и тот же `id` легитимно приходит
на разные `recipient`; дедуп по `(source, id)` схлопнул бы конверты разным людям. `id` уникально в
пределах `(source, recipient)`; формула discriminator внутри `id` — ответственность приватного
`external module`.

**Согласование с приватной стороной (#78).** Приватный `external module` строит
`id = {taskId}:{discriminator}` — получатель в `id` **НЕ входит**, он различается отдельной
координатой `recipient` тройного ключа (`external-integration-trigger-dedup.md` §2). Обе стороны на
одном ключе `(source, recipient, id)`; `id` уникален в пределах `(source, recipient)`. discriminator
источника: `created` | `status:{DateModified.Ticks}` | `moved:{DateModified.Ticks}` |
`comment:{commentId}`. (Ранняя редакция приватного дока предлагала зашить получателя в `id` и дедуп
`(source, id)` — отменена, приведена в соответствие с этим контрактом.)

**Retention (требование к resolver'у).** Дедуп ловит поздний ретрай, только пока resolver помнит
виденную тройку. Окно хранения виденных `(source, recipient, id)` ДОЛЖНО быть **≥ горизонта ретраев
H** источника (`external-integration-push.md` §3: at-least-once + backoff; численное `H` фиксируется
при выборе в реализации приватной стороны). В MVP resolver'а доставленные сообщения **не удаляются
вовсе** — дедуп сверяется со всем mailbox, требование выполнено тривиально (окно = ∞ ≥ H);
retention-обрезка — решение более поздней фазы.

## Enrollment endpoints (Фаза 4 — реализовано, выровнено с приватной #78)

**Поток (Flow B).** Код генерит **корп-сервис** (он авторитет владения account — пользователь там
залогинен): выдаёт код, регистрирует `hash(code) → account` на resolver (`register-code`) и показывает
сырой код пользователю один раз. Пользователь **вводит код на устройстве**; устройство редимит его на
`bind`. Устройство код НЕ генерит. (Дизайн-док §4 описывал обратный поток — устарел.)

`proof` абстрагирован: сейчас pairing-код, позже SSO-`id_token` — смена вида `proof` НЕ трогает этот
контракт (дизайн-док §4 «два независимых слоя»).

**Разделение секретов:** ingest-токен (события + `register-code`, per-source, «кто вправе КЛАСТЬ») ≠
pairing-код (`bind`, per-user, «кто вправе ПРИВЯЗАТЬСЯ») — разные механизмы, не смешивать.

**Хеш на стороне корпа.** Корп-сервис сам считает `hash(code)` (SHA-256, hex lower) и шлёт resolver'у
ТОЛЬКО хеш — сырой код периметр resolver'а не пересекает вовсе (сильнее, чем «не хранить сырой»).
Resolver кладёт полученный `code_hash` как есть; на `bind` он хеширует сырой `proof` и сверяет — обе
стороны обязаны использовать одну кодировку SHA-256 hex lower.

**Энтропия кода.** Отвечает генератор (корп). Приватная сторона выбрала короткий человекочитаемый код
(~49 бит) под ручной ввод, компенсируя коротким TTL (минуты) + rate-limit на выдачу + одноразовостью.
Резолвер это не навязывает (хеширует, что дали). Поднять длину кода — возможное будущее ужесточение.

### `POST /enroll/register-code` (корп-сервис → resolver)

Авторизация — тот же per-source ingest-механизм (`Authorization: Bearer <ingest-token>`, валиден для
`source` из тела). Регистрирует `code_hash → (account_email, expires_at)`.

```
Request:  { "source": "svc-a", "code_hash": "<sha256 hex lower>",
            "account_email": "user@corp", "ttl_seconds": 300 }
          ttl_seconds: >0 → одноразовый код с TTL (cap 86400); 0/отрицательный → ВЕЧНЫЙ токен;
          отсутствует → дефолт RESOLVER_ENROLL_CODE_TTL_SECS.
Response: 201 { "expires_at": "2026-07-02T10:10:00Z" }  // у вечного expires_at = null
          400 — пустой account_email или code_hash не 64-символьный hex lower;
          401 — нет/неверный/не тот source токен.
Идемпотентность: повторная регистрация того же hash заменяет запись; истёкшие коды подчищаются.
```

**Вечный токен (`ttl_seconds ≤ 0`).** Не протухает по времени И не гасится при `bind` — **многоразовый**:
любое устройство, знающее токен, привязывается к account в любой момент (возвращается мульти-девайс
через один токен). Это опт-ин корп-стороны для сценария «сгенерить 1 список токенов и раздать в поля
навсегда»; resolver нейтрален — просто исполняет флаг. Последствие «любой, кто видит токен, читает
задачи account'а» — политика external module (в среде с общими задачами это приемлемо). Обычный
токен (`ttl_seconds > 0`) остаётся безопасным дефолтом: TTL + одноразовость.

### `POST /enroll/bind` (устройство → resolver)

Авторизация — сам `proof` (ingest-токен НЕ нужен). Resolver: `hash(proof)` → живой код → `account`,
дописывает устройство в `accounts[account]` (store §1.2). Обычный код **гасится** (одноразовость);
**вечный** (`expires_at = null`) остаётся — им можно привязать ещё устройства. Приватный ключ не
передаётся.

```
Request:  { "proof": "<raw code>", "public_key": "<Ed25519 base64>", "device_id": "<stable id>" }
Response: 200 { "account": "user@corp", "enrolled_at": "2026-07-02T10:05:00Z" }
          400 — пустой proof/device_id или невалидный public_key (не 32-байтный Ed25519);
          401 — код неизвестен / истёк / уже погашен (единый ответ, без оракула валидности кода).
Повторная привязка того же device_id обновляет ключ на месте (не дублирует устройство).
```

**Одноразовость vs ретрай.** Код гасится при успехе, поэтому ретрай `bind` после потерянного 200-ответа
вернёт 401, хотя устройство уже привязано. Клиент (Фаза 5) должен подтверждать привязку успешным
`poll`, а не повтором `bind`. Записи погашенных кодов не хранятся (сервер-nonce для in-window replay —
отложено, как и в `poll`).

## Закрытые/уточнённые пункты

- ~~Список `type` (1.3)~~ — ЗАКРЫТ: `task_created` | `task_status_changed` | `task_moved` |
  `task_comment_added`.
- ~~Формат `public_key`/подписи~~ — ЗАКРЫТ в Фазе 2: Ed25519, base64 (публичный ключ 32 байта,
  подпись 64 байта); проверка — `identity::verify_b64`.
- ~~Дедуп: получатель в `id` или в ключе~~ — ЗАКРЫТ: получатель — координата ключа
  `(source, recipient, id)`, в `id` не входит (обе стороны согласованы, см. «Дедупликация»).
- ~~Enrollment-endpoint'ы (форматы запроса/ответа, коды)~~ — ЗАКРЫТ в Фазе 4: `register-code` +
  `bind` (см. «Enrollment endpoints»). Store §1.2 расширен resolver-внутренним `pending_codes`.
