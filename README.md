## Nardy on Solana – Overview

Проект состоит из трёх слоёв:

- **On-chain**: `programs/pooler` – Anchor-программа `backgammon` (эскроу ставок, банк, финальный расчёт, аварийные сценарии).
- **Off-chain server**: `server` – Node.js + TypeScript + SQLite (хранение метаданных игр и ходов, WebSocket для оповещения клиентов).
- **Client**: `client` – React + TypeScript (UI для создания/подключения к играм и отправки ходов/завершения/отмены).

Оффчейн‑логика (валидация правил нард, обмен ходами, двойная подпись и т.п.) реализуется на клиенте и сервере; смарт‑контракт отвечает за деньги и финальные исходы (победа/возврат по тайм‑ауту/отмена).

---

## Требования

- **WSL**:
  - Rust + `cargo`
  - `solana-cli`
  - `anchor-cli`
  - Node.js (для `ts-node` и скриптов)
- **Windows**:
  - Node.js (LTS)
  - npm или yarn

---

## 1. Установка зависимостей

### Корень (скрипты + Anchor-тесты, WSL)

cd /mnt/c/custom/uni/tofd/nardy
npm install### Клиент (React, Windows)
hell
cd C:\custom\uni\tofd\nardy\client
npm install### Сервер (Node + SQLite, Windows)
hell
cd C:\custom\uni\tofd\nardy\server
npm install---

## 2. Локальный валидатор Solana (WSL)

cd /mnt/c/custom/uni/tofd/nardy

solana-test-validator --ledger solana-local-ledger --reset --limit-ledger-size 500Проверить конфиг:

solana config set --url http://127.0.0.1:8899
solana config get
# RPC URL: http://127.0.0.1:8899Пополнить локальные кошельки (по необходимости):

solana airdrop 10 --keypair keys/main-authority/main-authority.json
solana airdrop 10 --keypair keys/player1/player1.json
solana airdrop 10 --keypair keys/player2/player2.json---

## 3. Сборка и деплой Anchor-программы (WSL)

cd /mnt/c/custom/uni/tofd/nardy

# Сборка Anchor-программы
anchor build

# Деплой на localnet
anchor deployПроверка программы:

solana program show DmEwwQX5n6mt2Hgv923xmVLDQpWWcvYmTcm3yJbZ5xRr---

## 4. Off-chain скрипты (WSL)

Сценарии, работающие через `ts-node` и Anchor client:

cd /mnt/c/custom/uni/tofd/nardy

# Базовый сценарий:
# init_game -> join_game -> 2 хода -> finish_game (победа player1)
npx ts-node scripts/run-backgammon.ts

# 1) Инициатор создал игру и отменил её до входа второго (cancel_before_join)
npx ts-node scripts/cancel-before-join.ts

# 2) Игра с несколькими ходами, после таймаута force_refund возвращает всем их вклады
npx ts-node scripts/force-refund-demo.ts

# 3) Игра с несколькими ходами, затем оба вызывают manual_refund (взаимная отмена)
npx ts-node scripts/manual-refund-demo.tsСкрипты логируют:

- `GameState` (банк, статус, чей ход, `move_index`),
- балансы игроков в SOL после каждого шага.

---

## 5. Сервер (Node + TypeScript + SQLite, Windows)

Сервер хранит метаданные игр и ходов (оффчейн) и рассылает события по WebSocket.

Запуск:
hell
cd C:\custom\uni\tofd\nardy\server

# dev-режим с авто-перезапуском
npm run devИнтерфейсы:

- HTTP (`http://localhost:3001`):
  - `GET /health` – проверка.
  - `POST /api/games` – регистрация игры:
   
    { "gamePubkey": "...", "player1": "...", "player2": "..." }
      - `GET /api/games/:gamePubkey` – данные игры + список ходов.
  - `POST /api/games/:gamePubkey/move` – логирование хода:
   
    {
      "moveIndex": 1,
      "player": "playerPubkey",
      "boardPoints": [/* 24 чисел */],
      "dice": [d1, d2]
    }
    - WebSocket (`ws://localhost:3001`):
  - клиент после подключения шлёт:
   
    { "type": "subscribe", "gamePubkey": "...", "playerPubkey": "..." }
      - при новых ходах сервер шлёт подписчикам:
   
    {
      "type": "move",
      "gamePubkey": "...",
      "moveIndex": ...,
      "player": "...",
      "boardPoints": [...],
      "dice": [...],
      "createdAt": ...
    }
    SQLite-файл: `server/game-server.sqlite`.

---

## 6. Клиент (React + TypeScript, Windows)

Запуск:
hell
cd C:\custom\uni\tofd\nardy\client
npm run devVite поднимет фронт на `http://localhost:5173` (порт смотри в консоли).

Задачи клиента:

- UI для:
  - создания игры (`initGame` через Anchor),
  - присоединения ко входящей игре (`joinGame`),
  - отправки ходов (`makeMove`) с `board_points: [i8; 24]` и `dice: [u8; 2]`,
  - завершения (`finishGame`),
  - отмены (`cancelBeforeJoin`, `manualRefund`, `forceRefund`).
- Отрисовка доски по `board_points` (24 пункта, знак = владелец) и `dice`.
- Общение:
  - с Anchor-программой через `@coral-xyz/anchor` и `@solana/web3.js`,
  - с сервером по HTTP/WS для хранения/получения истории ходов и событий от соперника.

---

## 7. Кто за что отвечает

- **Solana / Anchor (`programs/pooler`)**:
  - хранит `GameState`:
    - игроки (`player1`, `player2`),
    - ставки и банк (`stake_lamports`, `move_fee_lamports`, `pot_lamports`),
    - вклад каждого игрока (`player*_deposit`, `player*_fees_paid`),
    - чекпоинт доски (`board_points: [i8; 24]`, `dice: [u8; 2]`),
    - статус, ход, тайм‑ауты;
  - операции:
    - `init_game`, `join_game`,
    - `make_move` (каждый ход = отдельная ончейн‑транзакция с поднятием банка),
    - `finish_game` (победитель),
    - `cancel_before_join` (вернуть депозит инициатору),
    - `force_refund` (аварийный возврат по тайм‑ауту),
    - `manual_refund` (взаимное завершение без тайм‑аута);
  - следит, чтобы ключевые операции подписывали оба игрока.

- **Server (`server`)**:
  - хранит в SQLite список игр и историю ходов (оффчейн),
  - даёт API для фронта (список игр, история ходов),
  - пушит обновления ходов по WebSocket подписанным клиентам,
  - не держит приватные ключи и не управляет lamports.

- **Client (`client`)**:
  - UI и UX,
  - общается с Anchor-программой (подписывает транзакции кошельком),
  - общается с сервером (история/синхронизация ходов),
  - реализует клиентскую логику нард и обмена ходами между игроками.