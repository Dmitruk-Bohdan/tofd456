import { AnchorProvider, type Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Logger } from "../utils/logger";

const logger = new Logger("AnchorClient");

export const PROGRAM_ID = new PublicKey("DmEwwQX5n6mt2Hgv923xmVLDQpWWcvYmTcm3yJbZ5xRr");
export const RPC_URL = "http://127.0.0.1:8899";

// Интерфейс для wallet-объекта, совместимого с AnchorProvider
type AnchorWallet = Wallet & {
  publicKey: PublicKey;
  payer: Keypair;
};

// Создаём wallet из Keypair для использования в браузере
function createWalletFromKeypair(keypair: Keypair): AnchorWallet {
  return {
    publicKey: keypair.publicKey,
    payer: keypair,
    // Подпись обычной Transaction (VersionedTransaction в учебном проекте не используем)
    // Используем any, чтобы не усложнять типы ради учебного стенда.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async signTransaction(tx: any): Promise<any> {
      (tx as Transaction).sign(keypair);
      return tx;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async signAllTransactions(txs: any[]): Promise<any[]> {
      return txs.map((tx) => {
        (tx as Transaction).sign(keypair);
        return tx;
      });
    },
  };
}

let provider: AnchorProvider | null = null;
let currentKeypair: Keypair | null = null;

/**
 * Загружает keypair из localStorage (если сохранён).
 */
export function loadKeypairFromStorage(): Keypair | null {
  try {
    const stored = localStorage.getItem("playerSecretKey");
    if (!stored) {
      logger.debug("No keypair found in localStorage");
      return null;
    }
    const secretKey = JSON.parse(stored);
    if (!Array.isArray(secretKey) || secretKey.length !== 64) {
      logger.warn("Invalid keypair format in localStorage");
      return null;
    }
    const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
    logger.info("Keypair loaded from localStorage", { pubkey: keypair.publicKey.toBase58() });
    return keypair;
  } catch (error: unknown) {
    logger.error("Failed to load keypair from localStorage", error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * Инициализирует Anchor provider.
 * Использует переданный keypair или загружает из localStorage.
 */
export function initAnchorClient(keypair?: Keypair): {
  provider: AnchorProvider;
} {
  logger.debug("initAnchorClient called", { hasKeypair: !!keypair });

  if (provider && keypair === currentKeypair) {
    logger.info("Anchor client already initialized, returning existing provider");
    return { provider };
  }

  logger.info("Initializing new Anchor client", { rpcUrl: RPC_URL, programId: PROGRAM_ID.toBase58() });

  const connection = new Connection(RPC_URL, "confirmed");
  logger.debug("Connection created", { rpcUrl: RPC_URL });

  // Используем переданный keypair, или загружаем из localStorage, или из env
  let devKeypair: Keypair;
  if (keypair) {
    logger.debug("Using provided keypair", { pubkey: keypair.publicKey.toBase58() });
    devKeypair = keypair;
  } else {
    const storedKeypair = loadKeypairFromStorage();
    if (storedKeypair) {
      logger.debug("Using keypair from localStorage");
      devKeypair = storedKeypair;
    } else {
      // Fallback: env или ошибка (в продакшене не должно быть генерации)
      const hasEnvSecret = !!import.meta.env.VITE_PLAYER1_SECRET;
      if (hasEnvSecret) {
        logger.debug("Using keypair from env");
        const secretKey = JSON.parse(import.meta.env.VITE_PLAYER1_SECRET);
        devKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
      } else {
        const error = new Error("No keypair provided. Please login first.");
        logger.error("Keypair initialization failed", error);
        throw error;
      }
    }
  }

  currentKeypair = devKeypair;
  const devWallet = createWalletFromKeypair(devKeypair);

  // Наш devWallet реализует минимальный интерфейс Wallet, достаточный для учебного проекта.
  provider = new AnchorProvider(connection, devWallet, {
    commitment: "confirmed",
  });
  logger.info("AnchorProvider created", { 
    walletPubkey: devWallet.publicKey.toBase58(),
    commitment: "confirmed",
    hasPayer: !!devWallet.payer,
  });

  // В браузерном клиенте мы не создаём объект Program из IDL, чтобы
  // обойти баги AccountClient/encode в @coral-xyz/anchor. Вместо этого
  // фронт сам формирует инструкции через web3.js, используя PROGRAM_ID.
  logger.info("Anchor client initialized (without Program instance)", {
    programId: PROGRAM_ID.toBase58(),
  });

  return { provider };
}

/**
 * Получить текущий provider (если уже инициализирован).
 */
export function getProvider(): AnchorProvider | null {
  logger.debug("getProvider called", { hasProvider: !!provider });
  return provider;
}

/**
 * Получить текущий keypair (если уже инициализирован).
 */
export function getCurrentKeypair(): Keypair | null {
  logger.debug("getCurrentKeypair called", { hasKeypair: !!currentKeypair });
  return currentKeypair;
}

/**
 * Получить connection к Solana.
 */
export function getConnection(): Connection {
  logger.debug("getConnection called");
  return new Connection(RPC_URL, "confirmed");
}

/**
 * Получить баланс аккаунта в SOL.
 */
export async function getBalance(pubkey: PublicKey): Promise<number> {
  const connection = getConnection();
  const balance = await connection.getBalance(pubkey);
  return balance / LAMPORTS_PER_SOL;
}

/**
 * Получить баланс текущего кошелька в SOL.
 */
export async function getCurrentBalance(): Promise<number | null> {
  const keypair = getCurrentKeypair();
  if (!keypair) {
    return null;
  }
  return getBalance(keypair.publicKey);
}

