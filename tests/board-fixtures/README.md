# Фикстуры файла доски

Образцы `todos.json` под контракт `docs/specs/tasks/spec.md#board-file` —
для конформанс-тестов Node- и Rust-писателей: замок, атомарная запись,
восстановление и версии схемы. Каталог общий для CLI (`scripts/cli`) и
приложения (`src-tauri`), поэтому лежит в корне репозитория, а не внутри
одного из них.

CURRENT для обоих писателей на этом шаге — `version: 2`.

## Список фикстур

| Файл | Что показывает | CLI (v2) | Приложение (v2) |
|---|---|---|---|
| `v1/empty.json` | пустая доска до миграции 1→2 | читается, пишет `version: 2` (доска пуста — мигрировать нечего) | читается, мигрирует в v2 |
| `v1/full.json` | три узла до миграции: 1) статус `pending`, `plan` пуст; 2) `plan` — указатель на `.claude/phases/`, архивируется в комментарий; 3) `plan` — цельный ритуальный markdown с замыслом и шагами, делится на `description`+`plan` | читается, пишет `version: 2`, но поле-ролевую миграцию не запускает — статус, `plan`-указатель и цельный markdown остаются как в файле (известная асимметрия, см. `Матрицу совместимости`) | читается, мигрирует в v2 |
| `v2/empty.json` | пустая доска CURRENT | читается | читается |
| `v2/full.json` | пять узлов CURRENT: узел №1 несёт все поля обеих схем кроме `change`/легаси-флага (`depends_on`, `links`, `produces`, `verify`, `retry_limit`, `budget_usd`, `parallel_limit`, `on_issue`, `kind`, `change_id`, `spec`, `spec_answers`, `spec_seen`, `outcome*`, `handoff*`, `status_history`, `comments`); узлы №2–3 — минимальные закрывающие узлы графа (`links`/`depends_on` цели); узел №4 — легаси change-root (`change: true`, БЕЗ `change_id` — старый и новый механизм принадлежности не смешиваются на одном узле); узел №5 — форма, которую пишет `todos.mjs::newTodo` при пустой заявке: явные `"scheduled_for": null` и `"plan": ""` вместо их отсутствия. Плюс запись `changes[]` — открытая (привязана к узлу №1 через `change_id`) и закрытая (`closed_at`, `migrated_from`) | читается, пишется без потерь (CLI не типизирует узлы построчно — писатель сквозной, и этот round-trip сегодня страхует именно ОТСУТСТВИЕ типизированной схемы, а не её проверку; станет проверкой полей, когда схема появится) | читается, пишется без потерь |
| `v2/unknown-field.json` | узел с полем `ext` (зарезервированное пространство под будущее расширение, см. `versions`) и с посторонним незнакомым полем `reviewer_note` | читается-и-пишется: `ext`/`reviewer_note` переживают запись — CLI переносит неизвестные поля как есть (известная асимметрия, см. `Матрицу совместимости`) | читается-но-не-пишется без потерь: оба поля стираются на первом же сохранении (ограничение записано в `versions`) |
| `v2/future-version.json` | `version: 99` — файл будущей схемы | читается-но-не-пишется: известные поля разбираются, запись отказывает кодом 4 без бэкапа | то же |
| `corrupt/truncated.json` | обрезанный JSON — не парсится | восстановление: код 4 на мутации, состояние восстановления на чтении | то же |
| `corrupt/not-object.json` | корень — массив, а не объект | восстановление | то же |
| `corrupt/todos-not-array.json` | `todos` — строка, а не массив | восстановление | то же |
| `corrupt/empty-file.json` | файл существует, 0 байт — не парсится как JSON | восстановление | то же |
| `corrupt/todo-field-type.json` | валидный JSON, `todos` — массив объектов, но у узла `number` — строка `"42"` вместо целого | **читается** — Node не типизирует поля узла построчно | **восстановление** — Rust разбирает файл типизированной схемой, несовпадение типа одного поля узла проваливает разбор всего файла (см. `board-file#recovery`, «известная асимметрия») |

## Матрица совместимости «версия писателя × версия файла»

Обе стороны (CLI и приложение) на этом шаге знают CURRENT = 2. Каждая строка
покрыта конформанс-тестом на каждой стороне — Node:
`scripts/cli/board-fixtures.test.mjs`, Rust: `mod tests` в
`src-tauri/src/todos.rs` (запускается `cargo test fixtures`; каждое новое имя
теста несёт подстроку `fixtures`).

| Файл \ Писатель | CLI v2 | Приложение v2 |
|---|---|---|
| `v1/*.json` (version 1) | читается, пишет `version: 2`; поле-ролевая миграция (архив `.claude/phases/`-указателя в комментарий, разбор ритуального markdown на `description`+`plan`, перезапись `pending`) не выполняется — **известная асимметрия**: `migrate_plan_roles` реализован только в приложении, CLI его не вызывает, поэтому статус/`plan`-указатель/markdown уходят в файл как есть. Покрыто: `describe("matrix row: v1/*.json (version 1) — CLI v2 writer")` → `it("v1/empty.json migrates version to 2 with an empty board")`, `it("v1 board keeps its plan fields as-is on a CLI write (no field-role migration on Node)")` | читается, мигрирует в v2 (статус, архив `.claude/phases/`-указателя в комментарий, разбор ритуального markdown), пишет v2. Покрыто: `v1_empty_fixtures_round_trips_to_v2`, `v1_full_fixtures_migrates_plan_roles_and_status_on_load` |
| `v2/*.json` (version 2, известные поля) | читается, пишет без потерь известных полей — сквозной писатель без типизированной схемы. Покрыто: `describe("matrix row: v2/*.json known fields — CLI v2 writer")` → `it("v2/empty.json round-trips untouched")`, `it("v2/full.json known fields round-trip losslessly")` | читается, пишет без потерь известных полей (типизированная схема `Todo`/`Change`, включая вложенные `comments`/`spec_answers`/`spec_seen`/`status_history`). Покрыто: `v2_empty_fixtures_round_trips`, `v2_full_fixtures_known_fields_round_trip_losslessly` |
| `v2/unknown-field.json` (version 2, посторонние поля) | читается-и-пишется: `ext`/`reviewer_note` переживают запись — **известная асимметрия**: CLI не типизирует узлы построчно и переносит неизвестные поля как есть, вместо того чтобы их стирать. Покрыто: `describe("matrix row: v2/unknown-field.json — CLI v2 writer")` → `it("ext and reviewer_note survive a CLI write (Node passes unknown fields through)")` | читается-но-не-пишется без потерь: посторонние поля стираются на записи — типизированная схема `Todo` их не знает. Покрыто: `v2_unknown_field_fixtures_ext_and_reviewer_note_are_dropped_on_write` |
| `v2/future-version.json` (version 99) | читается-но-не-пишется: запись отказывает кодом 4. Покрыто: `describe("matrix row: v2/future-version.json — CLI v2 writer")` → `it("reads known fields but refuses write with exit code 4 and leaves the file untouched")` | читается-но-не-пишется: запись отказывает кодом 4, файл не мутируется, бэкапа нет. Покрыто: `v2_future_version_fixtures_refuses_write_and_leaves_file_untouched` (+ `future_version_fixture_is_future_version_99` на читаемость, `load_for_write_refuses_unreadable_and_future_version_with_spec_messages` на текст отказа) |
| `corrupt/truncated.json`, `not-object.json`, `todos-not-array.json`, `empty-file.json` | не читается: восстановление (один бэкап, мутация отказывает кодом 4). Покрыто: `describe("matrix row: corrupt/*.json — CLI v2 writer")` → `` it(`corrupt/${name} is unreadable: read yields an empty board with one backup, write refuses with exit code 4`) `` по каждому файлу (см. также `scripts/cli/todos.test.mjs`, `scripts/cli/board-recover.test.mjs`) | не читается: восстановление. Покрыто: `corrupt_fixtures_are_unreadable` (+ `corrupt_backup_is_written_once_across_two_loads` на однократность бэкапа, `load_for_write_refuses_unreadable_and_future_version_with_spec_messages` на отказ записи) |
| `corrupt/todo-field-type.json` | читается (некритичное несовпадение типа), число остаётся строкой и переживает запись как есть. Покрыто: `it("corrupt/todo-field-type.json — Node still reads it (asymmetry with Rust) and round-trips the loose field")` | не читается: восстановление (см. таблицу выше). Покрыто: `corrupt_fixtures_are_unreadable` |
| `v2/full.json`, узел №2 (`links`/`depends_on`/`comments` отсутствуют) с явно записанными пустыми массивами вместо отсутствия | — | нормализация «отсутствующий массив == пустой» проверена отдельно. Покрыто: `missing_array_and_explicit_empty_array_fixtures_are_equivalent` |

«Читается-но-не-пишется» — не отказ команды целиком: чтение и вывод
проходят, отказывает именно попытка сохранить файл — мутирующая команда
завершается кодом 4, читающая печатает результат как обычно.

## Правила сравнения при round-trip

- **Сравнение — по разобранным значениям, не по байтам.** `5.0` и `5` —
  одно и то же число; массив, который писатель опустил (пустой,
  `skip_serializing_if`), и тот же массив, явно записанный пустым, — одно
  и то же поле. Конформанс-тест обязан грузить оба файла (исходный и
  результат записи) и сравнивать разобранные структуры, а не строки.
- **`v1/*.json` — особый случай.** Комментарий, который миграция
  добавляет узлу с `plan`-указателем на `.claude/phases/`, получает
  собственный `id` и `created_at` в момент миграции — эти два поля
  результата **исключаются** из сравнения с любым заранее записанным
  ожиданием (сравнивать можно только `body`, содержащий исходный текст
  указателя).
