import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import Database from "better-sqlite3";

const PORT = Number(process.env.PORT) || 3001;
const DB_PATH = process.env.DB_PATH || "game-server.sqlite";

// ----------------------------- DB SETUP -----------------------------

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    game_pubkey   TEXT UNIQUE NOT NULL,
    player1       TEXT NOT NULL,
    player2       TEXT NOT NULL,
    status        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS moves (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    game_pubkey   TEXT NOT NULL,
    move_index    INTEGER NOT NULL,
    player        TEXT NOT NULL,
    board_points  TEXT NOT NULL,
    dice          TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
`);

const insertGame = db.prepare(`
  INSERT OR IGNORE INTO games (game_pubkey, player1, player2, status, created_at, updated_at)
  VALUES (@game_pubkey, @player1, @player2, @status, @created_at, @updated_at)
`);

const updateGameStatus = db.prepare(`
  UPDATE games SET status = @status, updated_at = @updated_at WHERE game_pubkey = @game_pubkey
`);

const getGame = db.prepare(`
  SELECT * FROM games WHERE game_pubkey = ?
`);

const listMoves = db.prepare(`
  SELECT * FROM moves WHERE game_pubkey = ? ORDER BY move_index ASC
`);

const insertMove = db.prepare(`
  INSERT INTO moves (game_pubkey, move_index, player, board_points, dice, created_at)
  VALUES (@game_pubkey, @move_index, @player, @board_points, @dice, @created_at)
`);

// ----------------------------- HTTP API -----------------------------

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Регистрация игры (после on-chain init_game/join_game)
app.post("/api/games", (req, res) => {
  const { gamePubkey, player1, player2 } = req.body as {
    gamePubkey?: string;
    player1?: string;
    player2?: string;
  };

  if (!gamePubkey || !player1 || !player2) {
    return res.status(400).json({ error: "gamePubkey, player1, player2 are required" });
  }

  const now = Date.now();
  insertGame.run({
    game_pubkey: gamePubkey,
    player1,
    player2,
    status: "active",
    created_at: now,
    updated_at: now,
  });

  res.json({ ok: true });
});

// Получение состояния игры + истории ходов
app.get("/api/games/:gamePubkey", (req, res) => {
  const gamePubkey = req.params.gamePubkey;
  const game = getGame.get(gamePubkey);
  if (!game) {
    return res.status(404).json({ error: "Game not found" });
  }
  const moves = listMoves.all(gamePubkey);
  res.json({ game, moves });
});

// HTTP-логирование хода в БД (параллельно с on-chain make_move)
app.post("/api/games/:gamePubkey/move", (req, res) => {
  const gamePubkey = req.params.gamePubkey;
  const { moveIndex, player, boardPoints, dice } = req.body as {
    moveIndex?: number;
    player?: string;
    boardPoints?: number[];
    dice?: number[];
  };

  if (
    moveIndex === undefined ||
    !player ||
    !Array.isArray(boardPoints) ||
    !Array.isArray(dice)
  ) {
    return res.status(400).json({
      error: "moveIndex, player, boardPoints[], dice[] are required",
    });
  }

  const now = Date.now();
  insertMove.run({
    game_pubkey: gamePubkey,
    move_index: moveIndex,
    player,
    board_points: JSON.stringify(boardPoints),
    dice: JSON.stringify(dice),
    created_at: now,
  });

  updateGameStatus.run({
    game_pubkey: gamePubkey,
    status: "active",
    updated_at: now,
  });

  // Уведомим по WebSocket подписчиков этой игры
  broadcastToGame(gamePubkey, {
    type: "move",
    gamePubkey,
    moveIndex,
    player,
    boardPoints,
    dice,
    createdAt: now,
  });

  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log(`HTTP server listening on http://localhost:${PORT}`);
  console.log(`SQLite DB at ${DB_PATH}`);
});

// ----------------------------- WebSocket -----------------------------

type WsClient = {
  ws: import("ws").WebSocket;
  gamePubkey?: string;
  playerPubkey?: string;
};

const wss = new WebSocketServer({ server });
const clients = new Set<WsClient>();

function broadcastToGame(gamePubkey: string, payload: unknown) {
  const msg = JSON.stringify(payload);
  for (const client of clients) {
    if (client.gamePubkey === gamePubkey && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(msg);
    }
  }
}

wss.on("connection", (ws) => {
  const client: WsClient = { ws };
  clients.add(client);
  console.log("WS client connected");

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "subscribe") {
        client.gamePubkey = msg.gamePubkey;
        client.playerPubkey = msg.playerPubkey;
        console.log(
          `WS subscribe: game=${client.gamePubkey}, player=${client.playerPubkey}`
        );
        return;
      }

      // произвольное сообщение "chat" / "debug"
      if (msg.type === "chat" && client.gamePubkey) {
        broadcastToGame(client.gamePubkey, {
          type: "chat",
          from: client.playerPubkey,
          text: msg.text,
          ts: Date.now(),
        });
      }
    } catch (e) {
      console.error("WS message parse error:", e);
    }
  });

  ws.on("close", () => {
    clients.delete(client);
    console.log("WS client disconnected");
  });
});


