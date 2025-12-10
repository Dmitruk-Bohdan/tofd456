import { useState, useEffect, useCallback } from "react";
import CreateGameForm from "./components/CreateGameForm";
import JoinGameForm from "./components/JoinGameForm";
import LoginForm from "./components/LoginForm";
import WaitingForPlayer2Screen from "./components/WaitingForPlayer2Screen";
import GameScreen from "./components/GameScreen";
import { initAnchorClient, getCurrentBalance } from "./solana/anchorClient";
import { Keypair } from "@solana/web3.js";
import "./App.css";

type ViewMode = "menu" | "create" | "join";

interface WaitingGame {
  gamePubkey: string;
  player1Pubkey: string;
  player2Pubkey: string;
}

function App() {
  const [currentGamePubkey, setCurrentGamePubkey] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("menu");
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [playerPubkey, setPlayerPubkey] = useState<string | null>(null);
  const [waitingGame, setWaitingGame] = useState<WaitingGame | null>(null);

  const handleGameCreated = (gamePubkey: string, player1Pubkey: string, player2Pubkey: string) => {
    // Не переходим сразу к игре, показываем экран ожидания
    setWaitingGame({ gamePubkey, player1Pubkey, player2Pubkey });
  };

  const handlePlayer2Joined = () => {
    if (waitingGame) {
      setCurrentGamePubkey(waitingGame.gamePubkey);
      setWaitingGame(null);
    }
  };

  const handleGameJoined = (gamePubkey: string) => {
    setCurrentGamePubkey(gamePubkey);
  };

  const handleBackToMenu = () => {
    setCurrentGamePubkey(null);
    setViewMode("menu");
  };

  const refreshBalance = useCallback(async () => {
    const bal = await getCurrentBalance();
    setBalance(bal);
  }, []);

  const handleLogin = useCallback((keypair: Keypair) => {
    initAnchorClient(keypair);
    setIsLoggedIn(true);
    setPlayerPubkey(keypair.publicKey.toBase58());
    // Загружаем баланс
    refreshBalance();
  }, [refreshBalance]);

  const handleLogout = () => {
    localStorage.removeItem("playerSecretKey");
    setIsLoggedIn(false);
    setPlayerPubkey(null);
    setBalance(null);
  };

  // Проверяем, есть ли сохранённый ключ при загрузке
  useEffect(() => {
    const stored = localStorage.getItem("playerSecretKey");
    if (stored) {
      try {
        const secretKey = JSON.parse(stored);
        if (Array.isArray(secretKey) && secretKey.length === 64) {
          const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
          // Инициализируем напрямую, без вызова handleLogin
          initAnchorClient(keypair);
          // Используем setTimeout чтобы избежать синхронного setState в effect
          setTimeout(() => {
            setIsLoggedIn(true);
            setPlayerPubkey(keypair.publicKey.toBase58());
          }, 0);
        }
      } catch (error) {
        console.error("Failed to load keypair from storage", error);
      }
    }
  }, []);

  // Обновляем баланс периодически
  useEffect(() => {
    if (!isLoggedIn) return;
    
    // Первый вызов через небольшую задержку, чтобы избежать синхронного setState
    const timeoutId = setTimeout(() => {
      refreshBalance();
    }, 100);
    
    const interval = setInterval(() => {
      refreshBalance();
    }, 5000); // каждые 5 секунд
    
    return () => {
      clearTimeout(timeoutId);
      clearInterval(interval);
    };
  }, [isLoggedIn, refreshBalance]);

  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#ffffff", margin: 0, padding: 0 }}>
      <header
        style={{
          backgroundColor: "#ffffff",
          color: "#333",
          padding: "20px",
          textAlign: "center",
          position: "relative",
          borderBottom: "1px solid #e0e0e0",
        }}
      >
        <h1 style={{ color: "#333", margin: 0 }}>Nardy on Solana</h1>
        {isLoggedIn && (
          <div
            style={{
              position: "absolute",
              top: "20px",
              right: "20px",
              fontSize: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "5px",
              alignItems: "flex-end",
            }}
          >
            <div style={{ color: "#333" }}>
              <strong>Pubkey:</strong> {playerPubkey?.substring(0, 8)}...
            </div>
            <div style={{ color: "#333" }}>
              <strong>Balance:</strong> {balance !== null ? `${balance.toFixed(4)} SOL` : "Loading..."}
            </div>
            <button
              onClick={handleLogout}
              style={{
                padding: "5px 10px",
                fontSize: "12px",
                backgroundColor: "#6c757d",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                marginTop: "5px",
              }}
            >
              Logout
            </button>
          </div>
        )}
      </header>

      <main style={{ padding: 0, margin: 0, width: "100%" }}>
        {!isLoggedIn ? (
          <LoginForm onLogin={handleLogin} />
        ) : (
          <>
            {waitingGame ? (
              <WaitingForPlayer2Screen
                gamePubkey={waitingGame.gamePubkey}
                player1Pubkey={waitingGame.player1Pubkey}
                player2Pubkey={waitingGame.player2Pubkey}
                onPlayer2Joined={handlePlayer2Joined}
                onCancel={() => {
                  setWaitingGame(null);
                  setViewMode("menu");
                }}
              />
            ) : currentGamePubkey ? (
              <GameScreen gamePubkey={currentGamePubkey} onBack={handleBackToMenu} />
        ) : viewMode === "menu" ? (
          <div
            style={{
              maxWidth: "1200px",
              margin: "0 auto",
              padding: "40px",
              backgroundColor: "white",
              borderRadius: "8px",
              boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
            }}
          >
            <h2 style={{ textAlign: "center", marginBottom: "30px" }}>Choose an action</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: "15px" }}>
              <button
                onClick={() => setViewMode("create")}
                style={{
                  padding: "15px 30px",
                  fontSize: "16px",
                  backgroundColor: "#007bff",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                }}
              >
                Create New Game
              </button>
              <button
                onClick={() => setViewMode("join")}
                style={{
                  padding: "15px 30px",
                  fontSize: "16px",
                  backgroundColor: "#28a745",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                }}
              >
                Join Existing Game
              </button>
            </div>
          </div>
        ) : viewMode === "create" ? (
          <div>
            <button
              onClick={() => setViewMode("menu")}
              style={{
                marginBottom: "20px",
                padding: "8px 16px",
                backgroundColor: "#6c757d",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              ← Back
            </button>
            <CreateGameForm onGameCreated={handleGameCreated} />
          </div>
        ) : (
          <div>
            <button
              onClick={() => setViewMode("menu")}
              style={{
                marginBottom: "20px",
                padding: "8px 16px",
                backgroundColor: "#6c757d",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              ← Back
            </button>
            <JoinGameForm onGameJoined={handleGameJoined} />
          </div>
        )}
          </>
        )}
      </main>
    </div>
  );
}

export default App;
