import { useState } from "react";
import { initGame } from "../solana/gameService";
import { registerGame } from "../server/apiClient";
import { wsClient } from "../server/wsClient";
import { initAnchorClient } from "../solana/anchorClient";
import { Logger } from "../utils/logger";
import type { WSMessage } from "../server/wsClient";

const logger = new Logger("CreateGameForm");

interface CreateGameFormProps {
  onGameCreated: (gamePubkey: string, player1Pubkey: string, player2Pubkey: string) => void;
}

export default function CreateGameForm({ onGameCreated }: CreateGameFormProps) {
  const [player2Pubkey, setPlayer2Pubkey] = useState("");
  const [stake, setStake] = useState("0.5");
  const [moveFee, setMoveFee] = useState("0.01");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    logger.info("Form submitted", { player2Pubkey, stake, moveFee });
    
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

      logger.info("Player1 (creator) pubkey", { pubkey: provider.wallet.publicKey.toBase58() });

      // Валидация player2Pubkey
      logger.debug("Validating input");
      if (!player2Pubkey.trim()) {
        const error = new Error("Player 2 pubkey is required");
        logger.error("Validation failed", error);
        throw error;
      }

      const stakeNum = parseFloat(stake);
      const moveFeeNum = parseFloat(moveFee);

      if (isNaN(stakeNum) || stakeNum <= 0) {
        const error = new Error("Stake must be a positive number");
        logger.error("Validation failed", error, { stakeNum });
        throw error;
      }

      if (isNaN(moveFeeNum) || moveFeeNum <= 0) {
        const error = new Error("Move fee must be a positive number");
        logger.error("Validation failed", error, { moveFeeNum });
        throw error;
      }

      logger.info("Input validation passed", { stakeNum, moveFeeNum, player2Pubkey: player2Pubkey.trim() });

      // 1. Создание игры в Anchor
      logger.info("Step 1: Creating game in Anchor");
      const gamePubkey = await initGame(player2Pubkey.trim(), stakeNum, moveFeeNum);
      logger.info("Game created in Anchor", { gamePubkey });
      setSuccess(`Game created! Pubkey: ${gamePubkey}`);

      // 2. Регистрация игры на сервере
      logger.info("Step 2: Registering game on server", { gamePubkey });
      await registerGame({
        gamePubkey,
        player1: provider.wallet.publicKey.toBase58(),
        player2: player2Pubkey.trim(),
      });
      logger.info("Game registered on server", { gamePubkey });

      // 3. Подключение к WebSocket и подписка на игру
      logger.info("Step 3: Connecting to WebSocket");
      if (!wsClient.isConnected()) {
        logger.debug("WebSocket not connected, connecting...");
        wsClient.connect();
        // Ждём немного, чтобы соединение установилось
        await new Promise((resolve) => setTimeout(resolve, 500));
        logger.debug("WebSocket connection wait completed");
      }

      logger.info("Subscribing to game updates", { gamePubkey, playerPubkey: provider.wallet.publicKey.toBase58() });
      wsClient.subscribe(gamePubkey, provider.wallet.publicKey.toBase58());

      // Обработчик сообщений от сервера
      const messageHandler = (message: WSMessage) => {
        logger.debug("WebSocket message received in form", { messageType: message.type, gamePubkey: message.gamePubkey });
        if (message.type === "move" && message.gamePubkey === gamePubkey) {
          logger.info("Received move from opponent", { message });
          // Здесь можно обновить UI с новым ходом
        }
      };

      wsClient.onMessage(messageHandler);
      logger.debug("Message handler registered");

      // Вызываем callback с данными игры (но не переходим к игре, пока player2 не присоединится)
      logger.info("All steps completed, calling onGameCreated callback", { gamePubkey });
      onGameCreated(gamePubkey, provider.wallet.publicKey.toBase58(), player2Pubkey.trim());
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Failed to create game";
      logger.error("Error creating game", err instanceof Error ? err : new Error(String(err)), { player2Pubkey, stake, moveFee });
      setError(errorMessage);
    } finally {
      logger.debug("Form submission finished", { loading: false });
      setLoading(false);
    }
  };

  return (
    <div style={{ width: "100%", padding: "40px", color: "#000" }}>
      <h2 style={{ color: "#000" }}>Create New Game</h2>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: "15px" }}>
          <label htmlFor="player2" style={{ display: "block", marginBottom: "5px" }}>
            Player 2 Public Key:
          </label>
          <input
            id="player2"
            type="text"
            value={player2Pubkey}
            onChange={(e) => setPlayer2Pubkey(e.target.value)}
            placeholder="Enter player 2's public key"
            required
            style={{
              width: "100%",
              padding: "8px",
              fontSize: "14px",
              border: "1px solid #ccc",
              borderRadius: "4px",
            }}
          />
        </div>

        <div style={{ marginBottom: "15px" }}>
          <label htmlFor="stake" style={{ display: "block", marginBottom: "5px" }}>
            Stake (SOL):
          </label>
          <input
            id="stake"
            type="number"
            step="0.01"
            min="0.01"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            required
            style={{
              width: "100%",
              padding: "8px",
              fontSize: "14px",
              border: "1px solid #ccc",
              borderRadius: "4px",
            }}
          />
        </div>

        <div style={{ marginBottom: "15px" }}>
          <label htmlFor="moveFee" style={{ display: "block", marginBottom: "5px" }}>
            Move Fee (SOL):
          </label>
          <input
            id="moveFee"
            type="number"
            step="0.01"
            min="0.01"
            value={moveFee}
            onChange={(e) => setMoveFee(e.target.value)}
            required
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
              marginBottom: "15px",
              backgroundColor: "#fee",
              color: "#c00",
              borderRadius: "4px",
            }}
          >
            {error}
          </div>
        )}

        {success && (
          <div
            style={{
              padding: "10px",
              marginBottom: "15px",
              backgroundColor: "#efe",
              color: "#0c0",
              borderRadius: "4px",
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
            padding: "10px",
            fontSize: "16px",
            backgroundColor: loading ? "#ccc" : "#007bff",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Creating..." : "Create Game"}
        </button>
      </form>
    </div>
  );
}

