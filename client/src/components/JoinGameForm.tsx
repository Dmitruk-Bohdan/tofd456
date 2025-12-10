import { useState } from "react";
import { joinGame } from "../solana/gameService";
import { getGame, updateGameStatus } from "../server/apiClient";
import { wsClient } from "../server/wsClient";
import { initAnchorClient } from "../solana/anchorClient";
import { Logger } from "../utils/logger";
import type { WSMessage } from "../server/wsClient";

const logger = new Logger("JoinGameForm");

interface JoinGameFormProps {
  onGameJoined: (gamePubkey: string) => void;
}

export default function JoinGameForm({ onGameJoined }: JoinGameFormProps) {
  const [gamePubkey, setGamePubkey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    logger.info("Form submitted", { gamePubkey });

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // Используем уже инициализированный ключ из localStorage
      logger.debug("Using existing keypair from anchorClient");
      const { provider } = initAnchorClient();
      
      if (!provider || !provider.wallet) {
        const error = new Error("Wallet not initialized. Please login first.");
        logger.error("Wallet check failed", error);
        throw error;
      }

      logger.info("Player2 (joiner) pubkey", { pubkey: provider.wallet.publicKey.toBase58() });

      // Валидация gamePubkey
      logger.debug("Validating input");
      if (!gamePubkey.trim()) {
        const error = new Error("Game pubkey is required");
        logger.error("Validation failed", error);
        throw error;
      }

      // Проверяем, что игра существует на сервере
      logger.info("Step 1: Checking if game exists on server", { gamePubkey: gamePubkey.trim() });
      const gameData = await getGame(gamePubkey.trim());
      logger.info("Game data retrieved from server", {
        gamePubkey: gamePubkey.trim(),
        player1: gameData.game.player1,
        player2: gameData.game.player2,
        status: gameData.game.status,
      });

      // Проверяем, что текущий игрок - это ожидаемый player2
      const currentPlayerPubkey = provider.wallet.publicKey.toBase58();
      if (gameData.game.player2 !== currentPlayerPubkey) {
        const error = new Error(
          `Your wallet (${currentPlayerPubkey}) does not match expected player2 (${gameData.game.player2})`
        );
        logger.error("Player2 mismatch", error, {
          currentWallet: currentPlayerPubkey,
          expectedPlayer2: gameData.game.player2,
        });
        throw error;
      }

      // 1. Присоединение к игре в Anchor
      logger.info("Step 2: Joining game in Anchor", { gamePubkey: gamePubkey.trim() });
      await joinGame(gamePubkey.trim());
      logger.info("Game joined in Anchor", { gamePubkey: gamePubkey.trim() });

      // 2. Обновление статуса игры на сервере
      logger.info("Step 3: Updating game status on server", { gamePubkey: gamePubkey.trim() });
      await updateGameStatus(gamePubkey.trim(), "active");
      logger.info("Game status updated on server", { gamePubkey: gamePubkey.trim() });

      // 3. Подключение к WebSocket и подписка на игру
      logger.info("Step 4: Connecting to WebSocket");
      if (!wsClient.isConnected()) {
        logger.debug("WebSocket not connected, connecting...");
        wsClient.connect();
        // Ждём немного, чтобы соединение установилось
        await new Promise((resolve) => setTimeout(resolve, 500));
        logger.debug("WebSocket connection wait completed");
      }

      logger.info("Subscribing to game updates", {
        gamePubkey: gamePubkey.trim(),
        playerPubkey: provider.wallet.publicKey.toBase58(),
      });
      wsClient.subscribe(gamePubkey.trim(), provider.wallet.publicKey.toBase58());

      // Обработчик сообщений от сервера
      const messageHandler = (message: WSMessage) => {
        logger.debug("WebSocket message received in form", {
          messageType: message.type,
          gamePubkey: message.gamePubkey,
        });
        if (message.type === "move" && message.gamePubkey === gamePubkey.trim()) {
          logger.info("Received move from opponent", { message });
          // Здесь можно обновить UI с новым ходом
        }
      };

      wsClient.onMessage(messageHandler);
      logger.debug("Message handler registered");

      setSuccess(`Successfully joined game! Pubkey: ${gamePubkey.trim()}`);

      // Вызываем callback для перехода на экран игры
      logger.info("All steps completed, calling onGameJoined callback", { gamePubkey: gamePubkey.trim() });
      onGameJoined(gamePubkey.trim());
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Failed to join game";
      logger.error("Error joining game", err instanceof Error ? err : new Error(String(err)), { gamePubkey });
      setError(errorMessage);
    } finally {
      logger.debug("Form submission finished", { loading: false });
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        width: "100%",
        padding: "40px",
        backgroundColor: "white",
        color: "#000",
      }}
    >
      <h2 style={{ marginBottom: "20px", color: "#000" }}>Join Game</h2>

      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: "15px" }}>
          <label htmlFor="gamePubkey" style={{ display: "block", marginBottom: "5px" }}>
            Game Pubkey:
          </label>
          <input
            id="gamePubkey"
            type="text"
            value={gamePubkey}
            onChange={(e) => setGamePubkey(e.target.value)}
            placeholder="Enter game pubkey..."
            required
            disabled={loading}
            style={{
              width: "100%",
              padding: "8px",
              fontSize: "14px",
              border: "1px solid #ccc",
              borderRadius: "4px",
            }}
          />
        </div>

        {error && (
          <div
            style={{
              padding: "10px",
              backgroundColor: "#f8d7da",
              color: "#721c24",
              borderRadius: "4px",
              marginBottom: "15px",
            }}
          >
            {error}
          </div>
        )}

        {success && (
          <div
            style={{
              padding: "10px",
              backgroundColor: "#d4edda",
              color: "#155724",
              borderRadius: "4px",
              marginBottom: "15px",
            }}
          >
            {success}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            width: "100%",
            padding: "12px",
            fontSize: "16px",
            backgroundColor: loading ? "#6c757d" : "#28a745",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Joining..." : "Join Game"}
        </button>
      </form>
    </div>
  );
}

