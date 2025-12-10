import { Logger } from "../utils/logger";

const logger = new Logger("WebSocketClient");

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:3001";

export interface WSMessage {
  type: "subscribe" | "move" | "chat" | "error" | "move_request" | "move_signed" | "dice_rolled" | "turn_completed" | "turn_changed";
  gamePubkey?: string;
  playerPubkey?: string;
  moveIndex?: number;
  player?: string;
  boardPoints?: number[];
  dice?: number[];
  createdAt?: number;
  message?: string;
  error?: string;
  transactionData?: number[]; // Сериализованная транзакция (массив байтов)
  newTurn?: number; // 1 = player1, 2 = player2
}

type MessageHandler = (message: WSMessage) => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private messageHandlers: MessageHandler[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  /**
   * Подключается к WebSocket серверу.
   */
  connect(): void {
    logger.info("connect called", { wsUrl: WS_URL });

    if (this.ws?.readyState === WebSocket.OPEN) {
      logger.warn("WebSocket already connected");
      return;
    }

    try {
      logger.debug("Creating WebSocket connection", { wsUrl: WS_URL });
      this.ws = new WebSocket(WS_URL);

      this.ws.onopen = () => {
        logger.info("WebSocket connected successfully", { wsUrl: WS_URL });
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event) => {
        logger.debug("WebSocket message received", { dataLength: event.data.length });
        try {
          const message: WSMessage = JSON.parse(event.data);
          logger.debug("Message parsed", { messageType: message.type, message });
          this.messageHandlers.forEach((handler) => {
            try {
              handler(message);
            } catch (handlerError: unknown) {
              logger.error("Error in message handler", handlerError instanceof Error ? handlerError : new Error(String(handlerError)), { message });
            }
          });
        } catch (error: unknown) {
          logger.error("Error parsing WebSocket message", error instanceof Error ? error : new Error(String(error)), { rawData: event.data });
        }
      };

      this.ws.onerror = (error: Event) => {
        logger.error("WebSocket error", new Error("WebSocket error occurred"), { error });
      };

      this.ws.onclose = (event) => {
        logger.warn("WebSocket disconnected", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
        this.ws = null;
        this.attemptReconnect();
      };
    } catch (error: unknown) {
      logger.error("Failed to connect WebSocket", error instanceof Error ? error : new Error(String(error)), { wsUrl: WS_URL });
    }
  }

  /**
   * Попытка переподключения.
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      const error = new Error("Max reconnect attempts reached");
      logger.error("Max reconnect attempts reached", error, {
        attempts: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts,
      });
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;
    logger.info("Scheduling reconnect", {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: delay,
    });
    
    setTimeout(() => {
      logger.info("Attempting reconnect", { attempt: this.reconnectAttempts });
      this.connect();
    }, delay);
  }

  /**
   * Подписывается на обновления конкретной игры.
   */
  subscribe(gamePubkey: string, playerPubkey: string): void {
    logger.info("subscribe called", { gamePubkey, playerPubkey });

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const error = new Error("WebSocket not connected");
      logger.error("Cannot subscribe", error, { readyState: this.ws?.readyState });
      return;
    }

    const message: WSMessage = {
      type: "subscribe",
      gamePubkey,
      playerPubkey,
    };

    logger.debug("Sending subscribe message", { message });
    this.ws.send(JSON.stringify(message));
    logger.info("Subscribe message sent", { gamePubkey, playerPubkey });
  }

  /**
   * Отправляет сообщение в чат игры.
   */
  sendChat(gamePubkey: string, message: string): void {
    logger.info("sendChat called", { gamePubkey, messageLength: message.length });

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const error = new Error("WebSocket not connected");
      logger.error("Cannot send chat", error, { readyState: this.ws?.readyState });
      return;
    }

    const wsMessage: WSMessage = {
      type: "chat",
      gamePubkey,
      message,
    };

    logger.debug("Sending chat message", { wsMessage });
    this.ws.send(JSON.stringify(wsMessage));
    logger.info("Chat message sent", { gamePubkey });
  }

  /**
   * Регистрирует обработчик сообщений.
   */
  onMessage(handler: MessageHandler): void {
    logger.debug("onMessage handler registered", { handlersCount: this.messageHandlers.length + 1 });
    this.messageHandlers.push(handler);
  }

  /**
   * Удаляет обработчик сообщений.
   */
  offMessage(handler: MessageHandler): void {
    const beforeCount = this.messageHandlers.length;
    this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    logger.debug("onMessage handler removed", {
      beforeCount,
      afterCount: this.messageHandlers.length,
    });
  }

  /**
   * Отправляет запрос на подпись хода другому игроку.
   */
  sendMoveRequest(gamePubkey: string, message: WSMessage): void {
    logger.info("sendMoveRequest called", { gamePubkey, messageType: message.type });

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const error = new Error("WebSocket not connected");
      logger.error("Cannot send move request", error, { readyState: this.ws?.readyState });
      return;
    }

    logger.debug("Sending move request message", { message });
    this.ws.send(JSON.stringify(message));
    logger.info("Move request sent", { gamePubkey });
  }

  /**
   * Отправляет подписанный ход обратно запросившему игроку.
   */
  sendMoveSigned(gamePubkey: string, message: WSMessage): void {
    logger.info("sendMoveSigned called", { gamePubkey, messageType: message.type });

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const error = new Error("WebSocket not connected");
      logger.error("Cannot send signed move", error, { readyState: this.ws?.readyState });
      return;
    }

    logger.debug("Sending signed move message", { message });
    this.ws.send(JSON.stringify(message));
    logger.info("Signed move sent", { gamePubkey });
  }

  /**
   * Отправляет сообщение о завершении хода на сервер.
   */
  sendTurnCompleted(gamePubkey: string, playerPubkey: string, newTurn: number): void {
    logger.info("sendTurnCompleted called", { gamePubkey, playerPubkey, newTurn });

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const error = new Error("WebSocket not connected");
      logger.error("Cannot send turn completed", error, { readyState: this.ws?.readyState });
      return;
    }

    const message: WSMessage = {
      type: "turn_completed",
      gamePubkey,
      playerPubkey,
      newTurn,
    };

    logger.debug("Sending turn completed message", { message });
    this.ws.send(JSON.stringify(message));
    logger.info("Turn completed message sent", { gamePubkey, newTurn });
  }

  /**
   * Отключается от WebSocket.
   */
  disconnect(): void {
    logger.info("disconnect called");
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      logger.info("WebSocket closed");
    }
    this.messageHandlers = [];
    logger.debug("All message handlers cleared");
  }

  /**
   * Проверяет, подключён ли WebSocket.
   */
  isConnected(): boolean {
    const connected = this.ws?.readyState === WebSocket.OPEN;
    logger.debug("isConnected check", { connected, readyState: this.ws?.readyState });
    return connected;
  }
}

// Singleton instance
export const wsClient = new WebSocketClient();

