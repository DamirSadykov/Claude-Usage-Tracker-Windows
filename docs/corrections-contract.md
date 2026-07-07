# corrections — контракт доступа к обработанным транскриптам

> Контракт метрики «поправки пользователя на сессию» (задача t#101, часть разбора
> исхода t#86). Инструмент **собирает и считает** сигналы поправок из транскриптов
> Claude Code и отдаёт их как версионированный JSON. **Классификация** кандидата
> (correction vs refinement/approval/new_task/question) — дальнейший шаг, не
> входящий в эту метрику; её может выполнить любой потребитель контракта. Здесь —
> только дешёвый офлайн-детектор без LLM.
>
> **Интеграцию можно собрать самому** поверх этого контракта — см.
> [гайд по интеграции](./corrections-integration.md) ·
> [wiki](https://github.com/DamirSadykov/Claude-Usage-Tracker-Windows/wiki/Corrections-Integration).

## Как получить данные

```
node scripts/cli.mjs corrections scan [<session>] [--project <name>|--all] --json
node scripts/cli.mjs corrections label-template <session> [--out <file>]
node scripts/cli.mjs corrections eval --labels <file> --json
```

Источник — `~/.claude/projects/<encoded-cwd>/<session>.jsonl` (read-only). Модуль
никогда не пишет в доску задач и не трогает транскрипты.

## Версионирование

Каждый `--json` несёт `contract_version` (сейчас **1**). Потребитель обязан
пинить major и падать на неожиданном. Аддитивные поля версию не бампят; удаление
/ переименование / смена типа поля — бампят.

## `corrections.scan` (стат + кандидаты)

```jsonc
{
  "contract_version": 1,
  "kind": "corrections.scan",
  "sessions": [
    {
      "session": "<uuid>",
      "project_dir": "D--projects-MVPs-app",   // encoded cwd (папка транскрипта)
      "project": "app",                        // имя проекта (последний сегмент cwd), точный ключ фильтра
      "stats": {
        "assistant_turns": 31,          // дедуп по message.id (один ход = неск. строк JSONL)
        "user_turns": 5,                // реальные набранные ходы пользователя
        "candidate_corrections": 1,     // кандидаты слоя 1 (ВЕРХНЯЯ ГРАНИЦА)
        "done_claims": 1,               // ассистент заявил «готово»
        "rework_after_done": 0,         // кандидат сразу после «готово»
        "corrections_per_session": 0.032, // candidate/assistant_turns; null если знаменатель 0
        "rework_after_done_rate": 0.0     // rework/done_claims; null если знаменатель 0
      },
      "candidates": [ /* см. «Ход» ниже, только predicted=true */ ]
    }
  ]
}
```

## `corrections.labels` (worksheet для ручной разметки)

То же, что `scan`, но `labels[]` содержит **все** реальные ходы пользователя (не
только кандидатов) и у каждого есть пустое поле `gold` для разметки классом
`correction | refinement | approval | new_task | question`. Читается обратно
командой `eval`.

## Ход (turn) — общая форма

```jsonc
{
  "key": "<session>#<lineIndex>",       // стабильный идентификатор хода
  "text": "у тебя же в контексте должно быть, не?",
  "predicted": true,                    // слой 1 считает это кандидатом в correction
  "reasons": ["post-reject"],           // какие сигналы сработали (см. ниже)
  "preceded_by": "reject",              // "reject" | "interrupt" | null — структурный сигнал
  "after_done": false,                  // ход сразу после заявления «готово»
  "fault_hint": "likely-llm",           // "likely-llm" | "ambiguous" | "none"
  "evidence": {                         // контекст для внешнего классификатора
    "prev_assistant": "…последний текст ассистента (<=240 симв.)…",
    "rejected_tools": ["Bash"]          // имена отклонённых инструментов, если reject
  }
}
```

### `reasons` (сигналы слоя 1)

| reason | тип | смысл |
|---|---|---|
| `post-reject` | структурный | ход сразу после отклонённого tool_use (`tool_result is_error`) |
| `post-interrupt` | структурный | ход сразу после маркера прерывания |
| `negation-opener` | лексический | ход начинается с отрицания (нет/не так/зачем…) |
| `corrective-imperative` | лексический | корректирующий императив (переделай/откати/исправь…) |

### `fault_hint` — грубая атрибуция вины

Не вердикт, а подсказка, в какую корзину внешнему классификатору смотреть:

- **`likely-llm`** — есть структурный сигнал (post-reject/interrupt): пользователь
  остановил ассистента на действии, которого не хотел → почти всегда промах LLM.
- **`ambiguous`** — только лексический сигнал: может быть и «переделай, я
  передумал» (промах/смена курса пользователя, не ассистента).
- **`none`** — не кандидат.

`rework_after_done` — самый чистый прокси промаха LLM: заявил «готово», а
пользователь тут же правит = ложный сигнал завершения.

## `corrections.eval` (валидация слоя 1)

```jsonc
{ "contract_version": 1, "kind": "corrections.eval",
  "tp": 1, "fp": 0, "fn": 2, "tn": 2, "skipped": 0,
  "precision": 1.0, "recall": 0.333, "f1": 0.5 }
```

Positive = `correction`. Ходы с пустым `gold` пропускаются (`skipped`). Дисциплина
*holdout*: разметить руками ~30 сессий, посчитать precision/recall, затюнить порог
слоя 1 по recall до того, как поверх кандидатов встанет шаг классификации.

## Оговорка о тренде

`corrections_per_session` сравним только при **фиксированном составе задач**:
рост поправок ≠ ассистент хуже (задачи могли усложниться / вырос порог). Держать
как относительный тренд по похожим сессиям, не как абсолютную оценку.
