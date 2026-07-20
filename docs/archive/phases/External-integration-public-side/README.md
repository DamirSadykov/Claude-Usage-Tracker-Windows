# External integration public side

CC-task: #77

## Vision
Readonly-зеркало внешних задач в трекере через нейтральный resolver. Публичный код (resolver+instance) не знает про конкретный сервис; доступы/секреты не покидают периметр (санитизация на приватном external module). Отправитель авторизуется ingest-токеном, получатель - подписью устройства (Ed25519); привязка устройства к account - через enrollment (код сейчас, SSO позже). Транспорт resolver→instance: поллинг на старте.

## Phase index
<!-- Optional map of the phases against the vision — # · phase · what it
     unblocks · risk. Keeping it next to the Vision makes a drifting phase
     visible at a glance. -->

## Notes
> Context, decisions, how to run the phases, gotchas. The cli phases CLI does
> NOT overwrite this file after creation — add freely. Phases live in the
> sibling `Phase-N.md` files (one per phase); manage them with the CLI, not
> by hand.
