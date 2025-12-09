## Nardy on Solana

Три слоя:

- **On-chain** – `programs/pooler`: Anchor-программа `backgammon` (ставки, банк, победитель, отмены/рефанды).
- **Server** – `server`: Node.js + TS + SQLite (метаданные игр, история ходов, WebSocket-уведомления).
- **Client** – `client`: React + TS (UI, ходы, кнопки “join/finish/refund”, общение с on-chain и сервером).

Правила нард и обмен ходами – оффчейн (клиент + сервер). Смарт‑контракт отвечает только за деньги и финальное состояние игры.

---

## 1. Что поставить

**WSL (Linux среда для Solana/Anchor):**

- Rust + `cargo`
- `solana-cli`
- `anchor-cli`
- Node.js (для `ts-node` и скриптов в `scripts/`)

**Windows (для клиента и сервера):**

- Node.js (LTS)
- npm или yarn

---

## 2. Установка зависимостей

### Корень (WSL)

```bash
cd /mnt/c/custom/uni/tofd/nardy
npm install
```

### Клиент (React, Windows)

```powershell
cd C:\custom\uni\tofd\nardy\client
npm install
```

### Сервер (Node + SQLite, Windows)

```powershell
cd C:\custom\uni\tofd\nardy\server
npm install
```

---

## 3. Локальный валидатор и деплой (WSL)

```bash
cd /mnt/c/custom/uni/tofd/nardy

# Запуск локального валидатора
solana-test-validator --ledger solana-local-ledger --reset --limit-ledger-size 500

# Убедиться, что работаем с localnet
solana config set --url http://127.0.0.1:8899

# При необходимости аирдропы
solana airdrop 10 --keypair keys/main-authority/main-authority.json
solana airdrop 10 --keypair keys/player1/player1.json
solana airdrop 10 --keypair keys/player2/player2.json

# Сборка Anchor-программы
anchor build

# Деплой на локальный валидатор
anchor deploy
```

---

## 4. On-chain сценарии (WSL)

```bash
cd /mnt/c/custom/uni/tofd/nardy

# Полный игровой сценарий: init -> join -> 2 хода -> finish (победа player1)
npx ts-node scripts/run-backgammon.ts

# Инициатор создал игру и отменил её до входа второго
npx ts-node scripts/cancel-before-join.ts

# Игра с несколькими ходами, затем force_refund по тайм-ауту (деньги возвращаются обоим)
npx ts-node scripts/force-refund-demo.ts

# Игра с несколькими ходами, затем manual_refund (обоюдная отмена без тайм-аута)
npx ts-node scripts/manual-refund-demo.ts
```

Скрипты показывают:

- состояние `GameState` (банк, статус, чей ход, `move_index`),
- балансы игроков в SOL после каждого действия.

---

## 5. Сервер (Windows)

Сервер – тонкий слой вокруг SQLite + WebSocket:

- хранит список игр и историю ходов (оффчейн),
- даёт REST API для фронта,
- пушит новые ходы по WS подписавшимся клиентам.

Запуск в dev-режиме:

```powershell
cd C:\custom\uni\tofd\nardy\server
npm run dev
```

Что есть:

- HTTP `http://localhost:3001`:
  - `GET /health` – жив ли сервер.
  - `POST /api/games` – зарегистрировать игру:
    ```json
    { "gamePubkey": "...", "player1": "...", "player2": "..." }
    ```
  - `GET /api/games/:gamePubkey` – инфо об игре + список ходов.
  - `POST /api/games/:gamePubkey/move` – залогировать ход:
    ```json
    {
      "moveIndex": 1,
      "player": "playerPubkey",
      "boardPoints": [/* 24 чисел */],
      "dice": [d1, d2]
    }
    ```

- WebSocket `ws://localhost:3001`:
  - после подключения клиент шлёт:
    ```json
    { "type": "subscribe", "gamePubkey": "...", "playerPubkey": "..." }
    ```
  - при новых ходах сервер шлёт подписчикам:
    ```json
    {
      "type": "move",
      "gamePubkey": "...",
      "moveIndex": ...,
      "player": "...",
      "boardPoints": [...],
      "dice": [...],
      "createdAt": ...
    }
    ```

SQLite-файл лежит в `server/game-server.sqlite`.

---

## 6. Клиент (Windows, React + TS)

Фронт – это UI для игроков + glue‑код между Solana и сервером.

Запуск:

```powershell
cd C:\custom\uni\tofd\nardy\client
npm run dev
```

Vite откроет фронт на `http://localhost:5173` (порт смотри в консоли).

Основные задачи клиента:

- дать UI для:
  - создания игры (`initGame` через Anchor),
  - присоединения ко входящей игре (`joinGame`),
  - совершения ходов (`makeMove` с `board_points: [i8; 24]` и `dice: [u8; 2]`),
  - завершения (`finishGame`),
  - отмен/рефандов (`cancelBeforeJoin`, `manualRefund`, `forceRefund`);
- отрисовывать доску (24 пункта, знак числа = владелец) и текущие кубики;
- общаться:
  - с Anchor-программой через `@coral-xyz/anchor` + `@solana/web3.js`,
  - с сервером по HTTP/WS для истории ходов и живых обновлений от соперника.

---

## 7. Разделение ответственности

- **On-chain (`programs/pooler`)**:
  - хранит `GameState` (игроки, ставки, банк, вклады, чекпоинт доски/кубиков, статус, ход, тайм-ауты);
  - реализует `init_game`, `join_game`, `make_move`, `finish_game`, `cancel_before_join`, `force_refund`, `manual_refund`;
  - требует подписи обоих игроков там, где нужно взаимное согласие.

- **Server (`server`)**:
  - хранит список игр и ходов в SQLite;
  - даёт простой REST + WS поверх этого;
  - не оперирует приватными ключами и lamports.

- **Client (`client`)**:
  - показывает игрокам UI;
  - собирает/подписывает транзакции кошельком и шлёт их в сеть;
  - синхронизирует состояние игр через сервер.
