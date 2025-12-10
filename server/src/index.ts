import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import Database from "better-sqlite3";
import path from "path";

const PORT = process.env.PORT || 3001;
const DB_PATH = path.join(__dirname, "..", "game-server.sqlite");

// Простой логгер для сервера
class ServerLogger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private log(level: string, message: string, data?: any, error?: Error): void {
    const timestamp = new Date().toISOString();
    let log = `[${timestamp}] [${level}] [${this.context}] ${message}`;

    if (data !== undefined) {
      log += `\n  Data: ${JSON.stringify(data, null, 2)}`;
    }

    if (error) {
      log += `\n  Error: ${error.message}`;
      if (error.stack) {
        log += `\n  Stack: ${error.stack}`;
      }
    }

    console.log(log);
  }

  debug(message: string, data?: any): void {
    this.log("DEBUG", message, data);
  }

  info(message: string, data?: any): void {
    this.log("INFO", message, data);
  }

  warn(message: string, data?: any): void {
    this.log("WARN", message, data);
  }

  error(message: string, error?: Error, data?: any): void {
    this.log("ERROR", message, data, error);
  }
}

const logger = new ServerLogger("Server");

// Инициализация SQLite
logger.info("Initializing SQLite database", { dbPath: DB_PATH });
const db = new Database(DB_PATH);
logger.info("SQLite database opened");

// Создание таблиц
logger.debug("Creating database tables");
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
logger.info("Database tables created/verified");

// Express app
const app = express();
app.use(cors());
app.use(express.json());

// Middleware для логирования HTTP запросов
app.use((req, res, next) => {
  const start = Date.now();
  logger.info("HTTP request received", {
    method: req.method,
    path: req.path,
    query: req.query,
    body: req.method !== "GET" ? req.body : undefined,
  });

  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info("HTTP response sent", {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: duration,
    });
  });

  next();
});

// Health check
app.get("/health", (_req, res) => {
  logger.debug("Health check endpoint called");
  res.json({ ok: true });
});

// Регистрация игры
app.post("/api/games", (req, res) => {
  logger.info("POST /api/games called", { body: req.body });

  try {
    const { gamePubkey, player1, player2 } = req.body;

    if (!gamePubkey || !player1 || !player2) {
      const error = new Error("Missing required fields: gamePubkey, player1, player2");
      logger.error("Validation failed", error, { body: req.body });
      return res.status(400).json({ error: error.message });
    }

    logger.debug("Inserting game into database", { gamePubkey, player1, player2 });
    const now = Date.now();
    const stmt = db.prepare(
      "INSERT INTO games (game_pubkey, player1, player2, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    
    try {
      stmt.run(gamePubkey, player1, player2, "waiting", now, now);
      logger.info("Game registered successfully", { gamePubkey, player1, player2 });
      res.json({ success: true, gamePubkey });
    } catch (dbError: any) {
      if (dbError.message.includes("UNIQUE constraint")) {
        logger.warn("Game already exists", { gamePubkey });
        res.status(409).json({ error: "Game already exists" });
      } else {
        throw dbError;
      }
    }
  } catch (error: any) {
    logger.error("Error in POST /api/games", error, { body: req.body });
    res.status(500).json({ error: error.message });
  }
});

// Получение игры и ходов
app.get("/api/games/:gamePubkey", (req, res) => {
  const { gamePubkey } = req.params;
  logger.info("GET /api/games/:gamePubkey called", { gamePubkey });

  try {
    logger.debug("Fetching game from database", { gamePubkey });
    const gameStmt = db.prepare("SELECT * FROM games WHERE game_pubkey = ?");
    const game = gameStmt.get(gamePubkey);

    if (!game) {
      logger.warn("Game not found", { gamePubkey });
      return res.status(404).json({ error: "Game not found" });
    }

    logger.debug("Fetching moves from database", { gamePubkey });
    const movesStmt = db.prepare("SELECT * FROM moves WHERE game_pubkey = ? ORDER BY move_index ASC");
    const moves = movesStmt.all(gamePubkey);

    logger.info("Game data retrieved", {
      gamePubkey,
      movesCount: moves.length,
    });

    res.json({ game, moves });
  } catch (error: any) {
    logger.error("Error in GET /api/games/:gamePubkey", error, { gamePubkey });
    res.status(500).json({ error: error.message });
  }
});

// Обновление статуса игры
app.patch("/api/games/:gamePubkey/status", (req, res) => {
  const { gamePubkey } = req.params;
  logger.info("PATCH /api/games/:gamePubkey/status called", { gamePubkey, body: req.body });

  try {
    const { status } = req.body;

    if (!status) {
      const error = new Error("Missing required field: status");
      logger.error("Validation failed", error, { body: req.body });
      return res.status(400).json({ error: error.message });
    }

    logger.debug("Updating game status in database", { gamePubkey, status });
    const now = Date.now();
    const stmt = db.prepare("UPDATE games SET status = ?, updated_at = ? WHERE game_pubkey = ?");
    const result = stmt.run(status, now, gamePubkey);

    if (result.changes === 0) {
      logger.warn("Game not found for status update", { gamePubkey });
      return res.status(404).json({ error: "Game not found" });
    }

    logger.info("Game status updated successfully", { gamePubkey, status });
    res.json({ success: true, gamePubkey, status });
  } catch (error: any) {
    logger.error("Error in PATCH /api/games/:gamePubkey/status", error, { gamePubkey, body: req.body });
    res.status(500).json({ error: error.message });
  }
});

// Бросок кубиков для игры
app.post("/api/games/:gamePubkey/roll-dice", (req, res) => {
  const { gamePubkey } = req.params;
  logger.info("POST /api/games/:gamePubkey/roll-dice called", { gamePubkey });

  try {
    // Бросаем два кубика (1-6 каждый)
    const dice1 = Math.floor(Math.random() * 6) + 1;
    const dice2 = Math.floor(Math.random() * 6) + 1;
    const dice = [dice1, dice2];

    logger.info("Dice rolled", { gamePubkey, dice });

    // Рассылаем результаты броска всем подписанным клиентам через WebSocket
    const diceMessage = {
      type: "dice_rolled",
      gamePubkey,
      dice,
      createdAt: Date.now(),
    };

    logger.debug("Broadcasting dice roll to WebSocket clients", { gamePubkey, dice });
    let broadcastCount = 0;
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && clientSubscriptions.has(client)) {
        const subscription = clientSubscriptions.get(client);
        if (subscription?.gamePubkey === gamePubkey) {
          logger.debug("Sending dice roll to subscribed client", {
            gamePubkey,
            playerPubkey: subscription.playerPubkey,
          });
          client.send(JSON.stringify(diceMessage));
          broadcastCount++;
        }
      }
    });

    logger.info("Dice roll broadcasted", { gamePubkey, dice, clientsNotified: broadcastCount });

    res.json({ success: true, dice });
  } catch (error: any) {
    logger.error("Error in POST /api/games/:gamePubkey/roll-dice", error, { gamePubkey });
    res.status(500).json({ error: error.message });
  }
});

// Логирование хода
app.post("/api/games/:gamePubkey/move", (req, res) => {
  const { gamePubkey } = req.params;
  logger.info("POST /api/games/:gamePubkey/move called", { gamePubkey, body: req.body });

  try {
    const { moveIndex, player, boardPoints, dice } = req.body;

    if (!moveIndex || !player || !boardPoints || !dice) {
      const error = new Error("Missing required fields: moveIndex, player, boardPoints, dice");
      logger.error("Validation failed", error, { body: req.body });
      return res.status(400).json({ error: error.message });
    }

    logger.debug("Inserting move into database", { gamePubkey, moveIndex, player });
    const now = Date.now();
    const stmt = db.prepare(
      "INSERT INTO moves (game_pubkey, move_index, player, board_points, dice, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    stmt.run(gamePubkey, moveIndex, player, JSON.stringify(boardPoints), JSON.stringify(dice), now);

    logger.info("Move logged successfully", { gamePubkey, moveIndex, player });

    // Обновляем updated_at игры
    const updateStmt = db.prepare("UPDATE games SET updated_at = ? WHERE game_pubkey = ?");
    updateStmt.run(now, gamePubkey);

    // Рассылаем ход всем подписанным клиентам через WebSocket
    const moveMessage = {
      type: "move",
      gamePubkey,
      moveIndex,
      player,
      boardPoints,
      dice,
      createdAt: now,
    };

    logger.debug("Broadcasting move to WebSocket clients", { gamePubkey, moveIndex });
    let broadcastCount = 0;
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && clientSubscriptions.has(client)) {
        const subscription = clientSubscriptions.get(client);
        if (subscription?.gamePubkey === gamePubkey) {
          logger.debug("Sending move to subscribed client", {
            gamePubkey,
            playerPubkey: subscription.playerPubkey,
          });
          client.send(JSON.stringify(moveMessage));
          broadcastCount++;
        }
      }
    });

    logger.info("Move broadcasted", { gamePubkey, moveIndex, clientsNotified: broadcastCount });

    res.json({ success: true, moveIndex });
  } catch (error: any) {
    logger.error("Error in POST /api/games/:gamePubkey/move", error, { gamePubkey, body: req.body });
    res.status(500).json({ error: error.message });
  }
});

// Запуск HTTP сервера
const server = app.listen(PORT, () => {
  logger.info("HTTP server started", { port: PORT, dbPath: DB_PATH });
});

// WebSocket сервер
const wss = new WebSocketServer({ server });
const clientSubscriptions = new Map<WebSocket, { gamePubkey: string; playerPubkey: string }>();

logger.info("WebSocket server initialized");

wss.on("connection", (ws: WebSocket) => {
  logger.info("WebSocket client connected", {
    readyState: ws.readyState,
    clientsCount: wss.clients.size,
  });

  ws.on("message", (data: Buffer) => {
    logger.debug("WebSocket message received", { dataLength: data.length });

    try {
      const message = JSON.parse(data.toString());
      logger.debug("Message parsed", { messageType: message.type, message });

      if (message.type === "subscribe") {
        const { gamePubkey, playerPubkey } = message;
        if (!gamePubkey || !playerPubkey) {
          logger.warn("Invalid subscribe message", { message });
          ws.send(JSON.stringify({ type: "error", error: "Missing gamePubkey or playerPubkey" }));
          return;
        }

        logger.info("Client subscribed to game", { gamePubkey, playerPubkey });
        clientSubscriptions.set(ws, { gamePubkey, playerPubkey });

        ws.send(JSON.stringify({ type: "subscribed", gamePubkey, playerPubkey }));
      } else if (message.type === "chat") {
        const { gamePubkey, message: chatMessage } = message;
        logger.info("Chat message received", { gamePubkey, messageLength: chatMessage?.length });

        // Рассылаем чат всем подписанным на эту игру
        let broadcastCount = 0;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && clientSubscriptions.has(client)) {
            const subscription = clientSubscriptions.get(client);
            if (subscription?.gamePubkey === gamePubkey) {
              client.send(JSON.stringify(message));
              broadcastCount++;
            }
          }
        });

        logger.info("Chat message broadcasted", { gamePubkey, clientsNotified: broadcastCount });
      } else if (message.type === "move_request") {
        // Запрос на подпись хода от одного игрока другому
        logger.info("Move request received", {
          gamePubkey: message.gamePubkey,
          fromPlayer: message.playerPubkey,
          moveIndex: message.moveIndex,
        });

        // Находим второго игрока и отправляем ему запрос
        const gameStmt = db.prepare("SELECT player1, player2 FROM games WHERE game_pubkey = ?");
        const game = gameStmt.get(message.gamePubkey) as { player1: string; player2: string } | undefined;

        if (!game) {
          logger.warn("Game not found for move request", { gamePubkey: message.gamePubkey });
          ws.send(JSON.stringify({ type: "error", error: "Game not found" }));
          return;
        }

        // Определяем, кому отправить (тому, кто НЕ отправил запрос)
        const targetPlayer =
          message.playerPubkey === game.player1 ? game.player2 : game.player1;

        logger.info("Forwarding move request to opponent", {
          gamePubkey: message.gamePubkey,
          fromPlayer: message.playerPubkey,
          toPlayer: targetPlayer,
        });

        // Рассылаем запрос всем подписанным на эту игру клиентам
        // (получатель сам определит, что это для него)
        let forwardedCount = 0;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && clientSubscriptions.has(client)) {
            const subscription = clientSubscriptions.get(client);
            if (subscription?.gamePubkey === message.gamePubkey) {
              client.send(JSON.stringify(message));
              forwardedCount++;
            }
          }
        });

        logger.info("Move request forwarded", {
          gamePubkey: message.gamePubkey,
          clientsNotified: forwardedCount,
        });
      } else if (message.type === "move_signed") {
        // Подписанный ход отправляется обратно запросившему игроку
        logger.info("Signed move received", {
          gamePubkey: message.gamePubkey,
          fromPlayer: message.playerPubkey,
          moveIndex: message.moveIndex,
        });

        // Находим первого игрока (того, кто запросил подпись)
        const gameStmt = db.prepare("SELECT player1, player2 FROM games WHERE game_pubkey = ?");
        const game = gameStmt.get(message.gamePubkey) as { player1: string; player2: string } | undefined;

        if (!game) {
          logger.warn("Game not found for signed move", { gamePubkey: message.gamePubkey });
          ws.send(JSON.stringify({ type: "error", error: "Game not found" }));
          return;
        }

        // Определяем, кому отправить (тому, кто НЕ подписал, т.е. кто запросил)
        const targetPlayer =
          message.playerPubkey === game.player1 ? game.player2 : game.player1;

        logger.info("Forwarding signed move to requester", {
          gamePubkey: message.gamePubkey,
          fromPlayer: message.playerPubkey,
          toPlayer: targetPlayer,
        });

        // Рассылаем подписанный ход всем подписанным на эту игру клиентам
        let forwardedCount = 0;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && clientSubscriptions.has(client)) {
            const subscription = clientSubscriptions.get(client);
            if (subscription?.gamePubkey === message.gamePubkey) {
              client.send(JSON.stringify(message));
              forwardedCount++;
            }
          }
        });

        logger.info("Signed move forwarded", {
          gamePubkey: message.gamePubkey,
          clientsNotified: forwardedCount,
        });
      } else if (message.type === "turn_completed") {
        // Первый игрок завершил ход и отправил транзакцию в блокчейн
        // Рассылаем turn_changed обоим игрокам для синхронизации UI
        logger.info("Turn completed received", {
          gamePubkey: message.gamePubkey,
          fromPlayer: message.playerPubkey,
          newTurn: message.newTurn,
        });

        // Рассылаем turn_changed всем подписанным на эту игру клиентам
        const turnChangedMessage = {
          type: "turn_changed",
          gamePubkey: message.gamePubkey,
          newTurn: message.newTurn,
        };

        let notifiedCount = 0;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && clientSubscriptions.has(client)) {
            const subscription = clientSubscriptions.get(client);
            if (subscription?.gamePubkey === message.gamePubkey) {
              client.send(JSON.stringify(turnChangedMessage));
              notifiedCount++;
            }
          }
        });

        logger.info("Turn changed notification sent", {
          gamePubkey: message.gamePubkey,
          newTurn: message.newTurn,
          clientsNotified: notifiedCount,
        });
      } else if (message.type === "finish_request") {
        // Запрос на завершение игры: пересылаем обоим игрокам (как move_request)
        logger.info("Finish request received", {
          gamePubkey: message.gamePubkey,
          fromPlayer: message.playerPubkey,
          winner: message.winnerPubkey,
        });

        let forwardedCount = 0;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && clientSubscriptions.has(client)) {
            const subscription = clientSubscriptions.get(client);
            if (subscription?.gamePubkey === message.gamePubkey) {
              client.send(JSON.stringify(message));
              forwardedCount++;
            }
          }
        });

        logger.info("Finish request forwarded", {
          gamePubkey: message.gamePubkey,
          clientsNotified: forwardedCount,
        });
      } else if (message.type === "finish_signed") {
        // Подписанный finish отправляется обратно инициатору
        logger.info("Signed finish received", {
          gamePubkey: message.gamePubkey,
          fromPlayer: message.playerPubkey,
        });

        // Находим инициатора (того, кто НЕ подписал, т.е. другой игрок)
        const gameStmt = db.prepare("SELECT player1, player2 FROM games WHERE game_pubkey = ?");
        const game = gameStmt.get(message.gamePubkey) as { player1: string; player2: string } | undefined;

        if (!game) {
          logger.warn("Game not found for signed finish", { gamePubkey: message.gamePubkey });
          ws.send(JSON.stringify({ type: "error", error: "Game not found" }));
          return;
        }

        const targetPlayer = message.playerPubkey === game.player1 ? game.player2 : game.player1;

        logger.info("Forwarding signed finish to requester", {
          gamePubkey: message.gamePubkey,
          fromPlayer: message.playerPubkey,
          toPlayer: targetPlayer,
        });

        let forwardedCount = 0;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && clientSubscriptions.has(client)) {
            const subscription = clientSubscriptions.get(client);
            if (subscription?.gamePubkey === message.gamePubkey) {
              client.send(JSON.stringify(message));
              forwardedCount++;
            }
          }
        });

        logger.info("Signed finish forwarded", {
          gamePubkey: message.gamePubkey,
          clientsNotified: forwardedCount,
        });
      } else if (message.type === "game_finished") {
        // Уведомление, что транзакция finish_game подтверждена
        logger.info("Game finished notification received", {
          gamePubkey: message.gamePubkey,
          winner: message.winnerPubkey,
        });

        let notifiedCount = 0;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && clientSubscriptions.has(client)) {
            const subscription = clientSubscriptions.get(client);
            if (subscription?.gamePubkey === message.gamePubkey) {
              client.send(JSON.stringify(message));
              notifiedCount++;
            }
          }
        });

        logger.info("Game finished broadcasted", {
          gamePubkey: message.gamePubkey,
          winner: message.winnerPubkey,
          clientsNotified: notifiedCount,
        });
      } else if (message.type === "manual_finished") {
        // Уведомление, что транзакция manual_refund подтверждена
        logger.info("Manual finished notification received", {
          gamePubkey: message.gamePubkey,
          requester: message.requesterPubkey,
        });

        let notifiedCount = 0;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && clientSubscriptions.has(client)) {
            const subscription = clientSubscriptions.get(client);
            if (subscription?.gamePubkey === message.gamePubkey) {
              client.send(JSON.stringify(message));
              notifiedCount++;
            }
          }
        });

        logger.info("Manual finished broadcasted", {
          gamePubkey: message.gamePubkey,
          requester: message.requesterPubkey,
          clientsNotified: notifiedCount,
        });
      } else {
        logger.warn("Unknown message type", { messageType: message.type });
      }
    } catch (error: any) {
      logger.error("Error processing WebSocket message", error, { rawData: data.toString() });
      ws.send(JSON.stringify({ type: "error", error: "Failed to process message" }));
    }
  });

  ws.on("error", (error: Error) => {
    logger.error("WebSocket error", error);
  });

  ws.on("close", () => {
    logger.info("WebSocket client disconnected", {
      hadSubscription: clientSubscriptions.has(ws),
      clientsCount: wss.clients.size - 1,
    });
    clientSubscriptions.delete(ws);
  });
});

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down gracefully");
  wss.close(() => {
    logger.info("WebSocket server closed");
  });
  server.close(() => {
    logger.info("HTTP server closed");
    db.close();
    logger.info("Database closed");
    process.exit(0);
  });
});

