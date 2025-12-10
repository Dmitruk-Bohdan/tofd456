import { useState } from "react";
import { Keypair } from "@solana/web3.js";
import { Logger } from "../utils/logger";

const logger = new Logger("LoginForm");

interface LoginFormProps {
  onLogin: (keypair: Keypair) => void;
}

export default function LoginForm({ onLogin }: LoginFormProps) {
  const [secretKeyInput, setSecretKeyInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      logger.debug("Attempting to parse secret key");
      
      // Парсим JSON массив из текстового поля
      let secretKey: number[];
      try {
        secretKey = JSON.parse(secretKeyInput.trim());
      } catch {
        const error = new Error("Invalid JSON format. Please paste the secret key array (e.g., [1,2,3,...])");
        logger.error("JSON parse failed", error);
        throw error;
      }

      if (!Array.isArray(secretKey) || secretKey.length !== 64) {
        const error = new Error("Secret key must be an array of 64 numbers");
        logger.error("Invalid secret key format", error, { length: secretKey.length });
        throw error;
      }

      // Создаём Keypair из секретного ключа
      const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
      logger.info("Keypair created from secret key", { pubkey: keypair.publicKey.toBase58() });

      // Сохраняем в localStorage
      localStorage.setItem("playerSecretKey", JSON.stringify(secretKey));
      logger.info("Secret key saved to localStorage");

      // Вызываем callback
      onLogin(keypair);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Failed to load keypair";
      logger.error("Login failed", err instanceof Error ? err : new Error(String(err)), { errorMessage });
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        const secretKey = JSON.parse(content);
        setSecretKeyInput(JSON.stringify(secretKey));
        logger.info("Secret key loaded from file");
      } catch (err: unknown) {
        logger.error("Failed to parse file", err instanceof Error ? err : new Error(String(err)));
        setError("Failed to parse key file. Make sure it's a valid JSON array.");
      }
    };
    reader.readAsText(file);
  };

  return (
    <div
      style={{
        maxWidth: "500px",
        margin: "0 auto",
        padding: "20px",
        backgroundColor: "white",
        borderRadius: "8px",
        boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
      }}
    >
      <h2 style={{ textAlign: "center", marginBottom: "20px" }}>Enter Your Wallet</h2>
      <p style={{ color: "#666", marginBottom: "20px", fontSize: "14px" }}>
        For this lab project, please enter your private key (secret key array). 
        In production, you would use a wallet like Phantom.
      </p>

      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: "15px" }}>
          <label htmlFor="secretKey" style={{ display: "block", marginBottom: "5px" }}>
            Secret Key (JSON array):
          </label>
          <textarea
            id="secretKey"
            value={secretKeyInput}
            onChange={(e) => setSecretKeyInput(e.target.value)}
            placeholder='Paste your secret key array here, e.g., [1,2,3,...]'
            required
            rows={4}
            style={{
              width: "100%",
              padding: "8px",
              fontSize: "14px",
              border: "1px solid #ccc",
              borderRadius: "4px",
              fontFamily: "monospace",
            }}
          />
        </div>

        <div style={{ marginBottom: "15px" }}>
          <label htmlFor="fileUpload" style={{ display: "block", marginBottom: "5px" }}>
            Or upload key file (JSON):
          </label>
          <input
            id="fileUpload"
            type="file"
            accept=".json"
            onChange={handleFileUpload}
            style={{
              width: "100%",
              padding: "8px",
              fontSize: "14px",
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

        <button
          type="submit"
          disabled={loading}
          style={{
            width: "100%",
            padding: "12px",
            fontSize: "16px",
            backgroundColor: loading ? "#ccc" : "#007bff",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Loading..." : "Login"}
        </button>
      </form>
    </div>
  );
}

