import { useEffect, useState } from "react";
import { getGameState, cancelGameBeforeJoin } from "../solana/gameService";
import { getProvider } from "../solana/anchorClient";
import { Logger } from "../utils/logger";

const logger = new Logger("WaitingForPlayer2Screen");

interface WaitingForPlayer2ScreenProps {
  gamePubkey: string;
  player1Pubkey: string;
  player2Pubkey: string;
  onPlayer2Joined: () => void;
  onCancel: () => void;
}

export default function WaitingForPlayer2Screen({
  gamePubkey,
  player1Pubkey,
  player2Pubkey,
  onPlayer2Joined,
  onCancel,
}: WaitingForPlayer2ScreenProps) {
  const [checking, setChecking] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  useEffect(() => {
    let isCancelled = false;

    const checkGameStatus = async () => {
      if (isCancelled) return;
      
      setChecking(true);
      try {
        const gameState = await getGameState(gamePubkey);
        if (gameState && gameState.status === "Active") {
          logger.info("Player2 has joined!", { gamePubkey, status: gameState.status });
          onPlayer2Joined();
        } else {
          logger.debug("Still waiting for player2", { 
            gamePubkey, 
            status: gameState?.status || "unknown" 
          });
        }
      } catch (error) {
        logger.error("Error checking game status", error as Error, { gamePubkey });
      } finally {
        if (!isCancelled) {
          setChecking(false);
        }
      }
    };

    // Проверяем сразу
    checkGameStatus();

    // Затем каждые 2 секунды
    const intervalId = setInterval(checkGameStatus, 2000);

    return () => {
      isCancelled = true;
      clearInterval(intervalId);
    };
  }, [gamePubkey, onPlayer2Joined]);

  return (
    <div
      style={{
        width: "100%",
        padding: "40px",
        backgroundColor: "white",
        textAlign: "center",
      }}
    >
      <h2 style={{ marginBottom: "20px", color: "#000" }}>Waiting for Player 2</h2>
      
      <div style={{ marginBottom: "30px" }}>
        <p style={{ fontSize: "16px", color: "#000", marginBottom: "15px" }}>
          Game created successfully! Share the game pubkey with Player 2:
        </p>
        <div
          style={{
            padding: "15px",
            backgroundColor: "#f5f5f5",
            borderRadius: "4px",
            marginBottom: "20px",
            wordBreak: "break-all",
            fontFamily: "monospace",
            fontSize: "14px",
            color: "#000",
            border: "1px solid #ccc",
          }}
        >
          <strong style={{ color: "#000" }}>Game Pubkey:</strong>
          <br />
          <span style={{ color: "#000" }}>{gamePubkey}</span>
        </div>
        
        <div style={{ marginBottom: "20px", fontSize: "14px", color: "#000" }}>
          <div>
            <strong>Player 1 (You):</strong> {player1Pubkey.substring(0, 8)}...
          </div>
          <div style={{ marginTop: "5px" }}>
            <strong>Player 2:</strong> {player2Pubkey.substring(0, 8)}...
          </div>
        </div>

        {checking && (
          <div style={{ marginTop: "20px", color: "#007bff" }}>
            Checking for player 2...
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: "10px", justifyContent: "center" }}>
        <button
          onClick={async () => {
            const provider = getProvider();
            const myPubkey = provider?.wallet?.publicKey?.toBase58();
            const isCreator = myPubkey === player1Pubkey;

            if (!isCreator) {
              alert("Только создатель игры может отменить её до присоединения второго игрока.");
              return;
            }

            try {
              setIsCancelling(true);
              const sig = await cancelGameBeforeJoin(gamePubkey);
              logger.info("Game cancelled before join", { gamePubkey, signature: sig });
              alert("Игра отменена, средства возвращены. Возврат в меню.");
              onCancel();
            } catch (e) {
              logger.error("Failed to cancel game", e as Error, { gamePubkey });
              alert("Не удалось отменить игру. Попробуйте ещё раз.");
            } finally {
              setIsCancelling(false);
            }
          }}
          disabled={isCancelling}
          style={{
            padding: "10px 20px",
            fontSize: "16px",
            backgroundColor: isCancelling ? "#ccc" : "#dc3545",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: isCancelling ? "not-allowed" : "pointer",
          }}
        >
          {isCancelling ? "Отмена..." : "Cancel"}
        </button>
      </div>
    </div>
  );
}

