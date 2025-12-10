import { Logger } from "../utils/logger";

const logger = new Logger("APIClient");

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

export interface GameRegistration {
  gamePubkey: string;
  player1: string;
  player2: string;
}

export interface Move {
  moveIndex: number;
  player: string;
  boardPoints: number[];
  dice: number[];
}

export interface GameData {
  game: {
    id: number;
    gamePubkey: string;
    player1: string;
    player2: string;
    status: string;
    createdAt: number;
    updatedAt: number;
  };
  moves: Array<{
    id: number;
    gamePubkey: string;
    moveIndex: number;
    player: string;
    boardPoints: string; // JSON string
    dice: string; // JSON string
    createdAt: number;
  }>;
}

/**
 * Регистрирует игру на сервере после создания в Anchor.
 */
export async function registerGame(game: GameRegistration): Promise<void> {
  logger.info("registerGame called", { game });

  try {
    const url = `${SERVER_URL}/api/games`;
    logger.debug("Sending POST request", { url, body: game });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(game),
    });

    logger.debug("Response received", {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Failed to register game: ${errorText}`);
      logger.error("Failed to register game", error, {
        status: response.status,
        statusText: response.statusText,
        errorText,
      });
      throw error;
    }

    logger.info("Game registered successfully", { gamePubkey: game.gamePubkey });
  } catch (error: any) {
    logger.error("Error in registerGame", error, { game });
    throw error;
  }
}

/**
 * Получает данные игры и историю ходов с сервера.
 */
export async function getGame(gamePubkey: string): Promise<GameData> {
  logger.info("getGame called", { gamePubkey });

  try {
    const url = `${SERVER_URL}/api/games/${gamePubkey}`;
    logger.debug("Sending GET request", { url });

    const response = await fetch(url);

    logger.debug("Response received", {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Failed to get game: ${errorText}`);
      logger.error("Failed to get game", error, {
        status: response.status,
        statusText: response.statusText,
        errorText,
      });
      throw error;
    }

    const data = await response.json();
    logger.info("Game data retrieved", {
      gamePubkey,
      movesCount: data.moves?.length || 0,
    });
    return data;
  } catch (error: any) {
    logger.error("Error in getGame", error, { gamePubkey });
    throw error;
  }
}

/**
 * Логирует ход на сервере.
 */
export async function logMove(gamePubkey: string, move: Move): Promise<void> {
  logger.info("logMove called", { gamePubkey, move });

  try {
    const url = `${SERVER_URL}/api/games/${gamePubkey}/move`;
    logger.debug("Sending POST request", { url, body: move });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(move),
    });

    logger.debug("Response received", {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Failed to log move: ${errorText}`);
      logger.error("Failed to log move", error, {
        status: response.status,
        statusText: response.statusText,
        errorText,
      });
      throw error;
    }

    logger.info("Move logged successfully", { gamePubkey, moveIndex: move.moveIndex });
  } catch (error: any) {
    logger.error("Error in logMove", error, { gamePubkey, move });
    throw error;
  }
}

/**
 * Обновляет статус игры на сервере.
 */
export async function updateGameStatus(gamePubkey: string, status: string): Promise<void> {
  logger.info("updateGameStatus called", { gamePubkey, status });

  try {
    const url = `${SERVER_URL}/api/games/${gamePubkey}/status`;
    logger.debug("Sending PATCH request", { url, body: { status } });

    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status }),
    });

    logger.debug("Response received", {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Failed to update game status: ${errorText}`);
      logger.error("Failed to update game status", error, {
        status: response.status,
        statusText: response.statusText,
        errorText,
      });
      throw error;
    }

    logger.info("Game status updated successfully", { gamePubkey, status });
  } catch (error: any) {
    logger.error("Error in updateGameStatus", error, { gamePubkey, status });
    throw error;
  }
}

/**
 * Проверка здоровья сервера.
 */
export async function healthCheck(): Promise<boolean> {
  logger.debug("healthCheck called", { serverUrl: SERVER_URL });

  try {
    const response = await fetch(`${SERVER_URL}/health`);
    const isHealthy = response.ok;
    logger.debug("Health check result", { isHealthy, status: response.status });
    return isHealthy;
  } catch (error: any) {
    logger.warn("Health check failed", { error: error.message });
    return false;
  }
}

