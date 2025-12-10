import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { getConnection, getCurrentKeypair, PROGRAM_ID, getProvider } from "./anchorClient";
import idlJson from "../idl/backgammon.json";
import { Logger } from "../utils/logger";

const logger = new Logger("GameService");

/**
 * Инициализирует новую игру.
 * @param player2Pubkey - Публичный ключ второго игрока
 * @param stakeSol - Ставка в SOL (например, 0.5)
 * @param moveFeeSol - Комиссия за ход в SOL (например, 0.01)
 * @returns gamePubkey - Публичный ключ созданного аккаунта игры
 */
export async function initGame(
  player2Pubkey: string,
  stakeSol: number,
  moveFeeSol: number
): Promise<string> {
  logger.info("initGame called", { player2Pubkey, stakeSol, moveFeeSol });

  const provider = getProvider();
  if (!provider) {
    const error = new Error("Anchor provider not initialized. Call initAnchorClient() first.");
    logger.error("Provider not initialized", error);
    throw error;
  }

  const connection = provider.connection ?? getConnection();

  const player2PubkeyObj = new PublicKey(player2Pubkey);
  const stakeLamports = new BN(stakeSol * LAMPORTS_PER_SOL);
  const moveFeeLamports = new BN(moveFeeSol * LAMPORTS_PER_SOL);

  logger.debug("Parameters converted", {
    player2Pubkey: player2PubkeyObj.toBase58(),
    stakeLamports: stakeLamports.toString(),
    moveFeeLamports: moveFeeLamports.toString(),
  });

  // Генерируем новый keypair для аккаунта игры
  const gameKeypair = Keypair.generate();
  const gamePubkey = gameKeypair.publicKey;
  logger.info("Game keypair generated", { gamePubkey: gamePubkey.toBase58() });

  // Генерируем уникальный game_id (можно использовать timestamp или случайное число)
  const gameId = new BN(Date.now());
  logger.debug("Game ID generated", { gameId: gameId.toString() });

  try {
    // Получаем keypair - сначала пробуем из wallet provider'а, потом из глобального хранилища
    let player1Keypair: Keypair | null = null;
    let player1Pubkey: PublicKey | null = null;

    if (provider.wallet) {
      logger.debug("Trying to get keypair from provider wallet");
      player1Keypair = (provider.wallet as unknown as { payer: Keypair }).payer;
      player1Pubkey = provider.wallet.publicKey;
    }

    // Если не получилось из provider, используем глобальный keypair
    if (!player1Keypair) {
      logger.debug("Keypair not found in provider, using global keypair");
      const globalKeypair = getCurrentKeypair();
      if (globalKeypair) {
        player1Keypair = globalKeypair;
        player1Pubkey = globalKeypair.publicKey;
      }
    }

    if (!player1Keypair || !player1Pubkey) {
      const error = new Error("Keypair not available");
      logger.error("Keypair check failed", error, {
        hasProviderWallet: !!provider.wallet,
        hasGlobalKeypair: !!getCurrentKeypair(),
      });
      throw error;
    }
    
    logger.debug("Keypair retrieved successfully", {
      pubkey: player1Pubkey.toBase58(),
    });

    // Проверяем баланс и делаем airdrop если нужно (как в скриптах)
    const minRequiredLamports =
      stakeLamports.toNumber() +
      2 * moveFeeLamports.toNumber() +
      0.1 * LAMPORTS_PER_SOL;

    const currentBalance = await connection.getBalance(player1Pubkey);
    logger.debug("Player1 balance before airdrop check", {
      pubkey: player1Pubkey.toBase58(),
      currentBalance,
      minRequiredLamports,
    });

    if (currentBalance < minRequiredLamports) {
      const toAirdrop = minRequiredLamports - currentBalance;
      logger.info("Requesting airdrop for player1", {
        pubkey: player1Pubkey.toBase58(),
        toAirdrop,
      });
      const sig = await connection.requestAirdrop(player1Pubkey, toAirdrop);
      await connection.confirmTransaction(sig, "confirmed");
      logger.info("Airdrop for player1 confirmed", { signature: sig });
    }
    
    logger.debug("Preparing transaction", {
      player1Pubkey: player1Pubkey.toBase58(),
      gamePubkey: gamePubkey.toBase58(),
      gameId: gameId.toString(),
      stakeLamports: stakeLamports.toString(),
      moveFeeLamports: moveFeeLamports.toString(),
    });

    // Формируем data для инструкции init_game вручную по IDL.
    const initGameIdl = (idlJson.instructions as { name: string; discriminator: number[] }[]).find(
      (ix) => ix.name === "init_game"
    );
    if (!initGameIdl) {
      const error = new Error("init_game instruction not found in IDL");
      logger.error("IDL lookup failed", error);
      throw error;
    }

    const discriminator: number[] = initGameIdl.discriminator;
    const discBuffer = Buffer.from(discriminator);

    const gameIdBuf = gameId.toArrayLike(Buffer, "le", 8);
    const stakeBuf = stakeLamports.toArrayLike(Buffer, "le", 8);
    const moveFeeBuf = moveFeeLamports.toArrayLike(Buffer, "le", 8);
    const player2Buf = player2PubkeyObj.toBuffer();

    const data = Buffer.concat([discBuffer, gameIdBuf, stakeBuf, moveFeeBuf, player2Buf]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: gamePubkey, isSigner: true, isWritable: true },
        { pubkey: player1Pubkey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);

    logger.info("Sending initGame transaction to Solana (raw web3)...");
    const signature = await connection.sendTransaction(tx, [player1Keypair, gameKeypair]);
    await connection.confirmTransaction(signature, "confirmed");

    logger.info("initGame transaction successful", {
      transactionSignature: signature,
      gamePubkey: gamePubkey.toBase58(),
      player1Pubkey: player1Pubkey.toBase58(),
      player2Pubkey: player2PubkeyObj.toBase58(),
    });

    return gamePubkey.toBase58();
  } catch (error) {
    logger.error("Error in initGame", error as Error, {
      player2Pubkey,
      stakeSol,
      moveFeeSol,
      gamePubkey: gamePubkey.toBase58(),
    });
    throw error;
  }
}

/**
 * Отмена игры до присоединения второго игрока (cancel_before_join).
 * Возвращает средства первому игроку.
 */
export async function cancelGameBeforeJoin(gamePubkey: string): Promise<string> {
  logger.info("cancelGameBeforeJoin called", { gamePubkey });

  const provider = getProvider();
  if (!provider) {
    const error = new Error("Anchor provider not initialized. Call initAnchorClient() first.");
    logger.error("Provider not initialized", error);
    throw error;
  }

  const connection = provider.connection ?? getConnection();

  // Ключ игрока 1 (создателя)
  const myKeypair =
    (provider.wallet as unknown as { payer?: Keypair }).payer ?? getCurrentKeypair();
  if (!myKeypair) {
    const error = new Error("Keypair not available");
    logger.error("Keypair check failed", error);
    throw error;
  }

  const gamePubkeyObj = new PublicKey(gamePubkey);

  // Ищем дискриминатор инструкции cancel_before_join
  const cancelIdl = (idlJson.instructions as { name: string; discriminator: number[] }[]).find(
    (ix) => ix.name === "cancel_before_join"
  );
  if (!cancelIdl) {
    const error = new Error("cancel_before_join instruction not found in IDL");
    logger.error("IDL lookup failed", error);
    throw error;
  }

  const data = Buffer.from(cancelIdl.discriminator);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: gamePubkeyObj, isSigner: false, isWritable: true },
      { pubkey: myKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  tx.recentBlockhash = blockhash;
  tx.feePayer = myKeypair.publicKey;

  logger.info("Sending cancel_before_join to Solana...");
  const signature = await connection.sendTransaction(tx, [myKeypair]);
  await connection.confirmTransaction(signature, "confirmed");

  logger.info("cancel_before_join successful", {
    signature,
    gamePubkey,
    player1: myKeypair.publicKey.toBase58(),
  });

  return signature;
}

/**
 * Получает состояние игры из блокчейна.
 * @param gamePubkey - Публичный ключ аккаунта игры
 * @returns состояние игры или null если аккаунт не найден
 */
export async function getGameState(gamePubkey: string): Promise<{
  status: string;
  player1: string;
  player2: string;
  potLamports: string;
  currentTurn: number;
} | null> {
  logger.info("getGameState called", { gamePubkey });

  const connection = getConnection();
  const gamePubkeyObj = new PublicKey(gamePubkey);

  try {
    // Получаем данные аккаунта напрямую через web3.js
    const accountInfo = await connection.getAccountInfo(gamePubkeyObj);
    if (!accountInfo) {
      logger.warn("Game account not found", { gamePubkey });
      return null;
    }

    // Парсим данные аккаунта вручную по структуре GameState
    // Структура: discriminator (8) + player1 (32) + player2 (32) + game_id (8) + ...
    const data = accountInfo.data;
    if (data.length < 8) {
      logger.warn("Invalid game account data", { gamePubkey, dataLength: data.length });
      return null;
    }

    // Пропускаем discriminator (8 байт)
    let offset = 8;
    
    // player1 (32 байта)
    const player1Bytes = data.slice(offset, offset + 32);
    const player1 = new PublicKey(player1Bytes).toBase58();
    offset += 32;
    
    // player2 (32 байта)
    const player2Bytes = data.slice(offset, offset + 32);
    const player2 = new PublicKey(player2Bytes).toBase58();
    offset += 32;
    
    // game_id (8 байт) - пропускаем
    offset += 8;
    
    // stake_lamports (8 байт) - пропускаем
    offset += 8;
    
    // move_fee_lamports (8 байт) - пропускаем
    offset += 8;
    
    // pot_lamports (8 байт) - little-endian
    const potLamportsBytes = data.slice(offset, offset + 8);
    const potLamports = new BN(potLamportsBytes, "le").toString();
    offset += 8;
    
    // ... пропускаем остальные поля до current_turn
    // player1_deposit (8) + player2_deposit (8) + player1_fees_paid (8) + player2_fees_paid (8) + 
    // last_activity_slot (8) + move_index (8) + board_points (24) + dice (2) = 74 байт
    offset += 74;
    
    // current_turn (1 байт) - находится перед status
    const currentTurn = data[offset];
    offset += 1;
    
    // status - это enum, первый байт это вариант (0 = WaitingForPlayer2, 1 = Active, 2 = Finished)
    const statusByte = data[offset];
    const statusMap: Record<number, string> = {
      0: "WaitingForPlayer2",
      1: "Active",
      2: "Finished",
    };
    const status = statusMap[statusByte] || "Unknown";

    logger.info("Game state retrieved", {
      gamePubkey,
      status,
      player1,
      player2,
      potLamports,
      currentTurn,
    });

    return {
      status,
      player1,
      player2,
      potLamports,
      currentTurn,
    };
  } catch (error) {
    logger.error("Error fetching game state", error as Error, { gamePubkey });
    return null;
  }
}

/**
 * Присоединяется к существующей игре.
 * @param gamePubkey - Публичный ключ аккаунта игры
 * @returns void
 */
export async function joinGame(gamePubkey: string): Promise<void> {
  logger.info("joinGame called", { gamePubkey });

  const provider = getProvider();
  if (!provider) {
    const error = new Error("Anchor provider not initialized. Call initAnchorClient() first.");
    logger.error("Provider not initialized", error);
    throw error;
  }

  const connection = provider.connection ?? getConnection();
  const gamePubkeyObj = new PublicKey(gamePubkey);

  if (!provider.wallet) {
    const error = new Error("Wallet not available in provider");
    logger.error("Wallet check failed", error);
    throw error;
  }

  const player2Pubkey = provider.wallet.publicKey;
  let player2Keypair: Keypair | null =
    (provider.wallet as unknown as { payer: Keypair | null }).payer ?? null;

  if (!player2Keypair) {
    logger.debug("Player2 keypair not found in provider, using global keypair (if any)");
    const globalKeypair = getCurrentKeypair();
    if (globalKeypair && globalKeypair.publicKey.equals(player2Pubkey)) {
      player2Keypair = globalKeypair;
    }
  }

  if (!player2Keypair) {
    const error = new Error("Player2 keypair not available");
    logger.error("Keypair check failed for joinGame", error);
    throw error;
  }

  logger.debug("Preparing joinGame transaction", {
    gamePubkey: gamePubkeyObj.toBase58(),
    player2Pubkey: player2Pubkey.toBase58(),
  });

  try {
    // Формируем data для инструкции join_game вручную по IDL.
    const joinGameIdl = (idlJson.instructions as { name: string; discriminator: number[] }[]).find(
      (ix) => ix.name === "join_game"
    );
    if (!joinGameIdl) {
      const error = new Error("join_game instruction not found in IDL");
      logger.error("IDL lookup failed", error);
      throw error;
    }

    const discriminator: number[] = joinGameIdl.discriminator;
    const data = Buffer.from(discriminator);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: gamePubkeyObj, isSigner: false, isWritable: true },
        { pubkey: player2Pubkey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);

    logger.info("Sending joinGame transaction to Solana (raw web3)...");
    const signature = await connection.sendTransaction(tx, [player2Keypair]);
    await connection.confirmTransaction(signature, "confirmed");

    logger.info("joinGame transaction successful", {
      transactionSignature: signature,
      gamePubkey: gamePubkeyObj.toBase58(),
      player2Pubkey: player2Pubkey.toBase58(),
    });
  } catch (error) {
    logger.error("Error in joinGame", error as Error, { gamePubkey });
    throw error;
  }
}

/**
 * Делает ход в игре (make_move).
 * Требует подписи ОБОИХ игроков - эта функция вызывается после того,
 * как оба игрока подписали транзакцию через WebSocket.
 * @param gamePubkey - Публичный ключ аккаунта игры
 * @param newBoardPoints - Новое состояние доски [i8; 24]
 * @param newDice - Новые значения кубиков [u8; 2]
 * @returns transaction signature
 */
export async function makeMove(
  gamePubkey: string,
  newBoardPoints: number[],
  newDice: [number, number]
): Promise<string> {
  logger.info("makeMove called", {
    gamePubkey,
    newBoardPoints,
    newDice,
  });

  const provider = getProvider();
  if (!provider) {
    const error = new Error("Anchor provider not initialized. Call initAnchorClient() first.");
    logger.error("Provider not initialized", error);
    throw error;
  }

  const connection = provider.connection ?? getConnection();
  const gamePubkeyObj = new PublicKey(gamePubkey);

  if (!provider.wallet) {
    const error = new Error("Wallet not available in provider");
    logger.error("Wallet check failed", error);
    throw error;
  }

  // Получаем keypair текущего игрока
  let myKeypair: Keypair | null =
    (provider.wallet as unknown as { payer: Keypair | null }).payer ?? null;

  if (!myKeypair) {
    logger.debug("Keypair not found in provider, using global keypair");
    const globalKeypair = getCurrentKeypair();
    if (globalKeypair) {
      myKeypair = globalKeypair;
    }
  }

  if (!myKeypair) {
    const error = new Error("Keypair not available");
    logger.error("Keypair check failed", error);
    throw error;
  }

  const myPubkey = myKeypair.publicKey;

  logger.debug("Keypair retrieved for makeMove", { pubkey: myPubkey.toBase58() });

  try {
    // Получаем состояние игры из блокчейна, чтобы узнать второго игрока
    const gameState = await getGameState(gamePubkey);
    if (!gameState) {
      const error = new Error("Game state not found");
      logger.error("Game state check failed", error, { gamePubkey });
      throw error;
    }

    logger.info("Game state retrieved", {
      gamePubkey,
      player1: gameState.player1,
      player2: gameState.player2,
      status: gameState.status,
    });

    // Определяем, кто мы (player1 или player2)
    const isPlayer1 = myPubkey.toBase58() === gameState.player1;
    const player1Pubkey = new PublicKey(gameState.player1);
    const player2Pubkey = new PublicKey(gameState.player2);

    logger.info("Player identification", {
      myPubkey: myPubkey.toBase58(),
      isPlayer1,
      player1Pubkey: player1Pubkey.toBase58(),
      player2Pubkey: player2Pubkey.toBase58(),
    });

    // Формируем data для инструкции make_move
    const makeMoveIdl = (idlJson.instructions as { name: string; discriminator: number[] }[]).find(
      (ix) => ix.name === "make_move"
    );
    if (!makeMoveIdl) {
      const error = new Error("make_move instruction not found in IDL");
      logger.error("IDL lookup failed", error);
      throw error;
    }

    const discriminator: number[] = makeMoveIdl.discriminator;
    const discBuffer = Buffer.from(discriminator);

    // Проверяем, что newBoardPoints имеет длину 24
    if (newBoardPoints.length !== 24) {
      const error = new Error(`Invalid boardPoints length: expected 24, got ${newBoardPoints.length}`);
      logger.error("Validation failed", error, { boardPointsLength: newBoardPoints.length });
      throw error;
    }

    // Конвертируем boardPoints в i8 массив (значения от -128 до 127)
    const boardPointsBuffer = Buffer.alloc(24);
    for (let i = 0; i < 24; i++) {
      const value = Math.max(-128, Math.min(127, newBoardPoints[i]));
      boardPointsBuffer.writeInt8(value, i);
    }

    logger.debug("Board points converted", {
      original: newBoardPoints,
      converted: Array.from({ length: 24 }, (_, i) => boardPointsBuffer.readInt8(i)),
    });

    // Проверяем dice
    if (newDice.length !== 2) {
      const error = new Error(`Invalid dice length: expected 2, got ${newDice.length}`);
      logger.error("Validation failed", error, { diceLength: newDice.length });
      throw error;
    }

    const diceBuffer = Buffer.from(newDice);

    // Собираем data: discriminator + boardPoints (24 bytes) + dice (2 bytes)
    const data = Buffer.concat([discBuffer, boardPointsBuffer, diceBuffer]);

    logger.debug("Instruction data prepared", {
      discriminatorLength: discBuffer.length,
      boardPointsLength: boardPointsBuffer.length,
      diceLength: diceBuffer.length,
      totalDataLength: data.length,
    });

    // Формируем инструкцию
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: gamePubkeyObj, isSigner: false, isWritable: true },
        { pubkey: player1Pubkey, isSigner: true, isWritable: true },
        { pubkey: player2Pubkey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);

    logger.info("Transaction prepared, signing with my keypair", {
      gamePubkey: gamePubkeyObj.toBase58(),
      player1Pubkey: player1Pubkey.toBase58(),
      player2Pubkey: player2Pubkey.toBase58(),
      myPubkey: myPubkey.toBase58(),
      isPlayer1,
    });

    // Подписываем транзакцию своим keypair
    tx.sign(myKeypair);

    logger.info("Transaction signed by me", {
      myPubkey: myPubkey.toBase58(),
      signaturesCount: tx.signatures.length,
    });

    // Отправляем транзакцию
    logger.info("Sending makeMove transaction to Solana...");
    // Транзакция уже полностью подписана обоими игроками, signers не нужны
    const signature = await connection.sendTransaction(tx, [], {
      skipPreflight: false,
    });
    await connection.confirmTransaction(signature, "confirmed");

    logger.info("makeMove transaction successful", {
      transactionSignature: signature,
      gamePubkey: gamePubkeyObj.toBase58(),
      boardPoints: newBoardPoints,
      dice: newDice,
    });

    return signature;
  } catch (error) {
    logger.error("Error in makeMove", error as Error, {
      gamePubkey,
      newBoardPoints,
      newDice,
    });
    throw error;
  }
}

/**
 * Создает транзакцию для manual_refund (односторонний возврат средств).
 * Требует подписи только одного игрока (requester), который также платит комиссию.
 */
export async function createManualRefundTransaction(gamePubkey: string): Promise<Transaction> {
  logger.info("createManualRefundTransaction called", { gamePubkey });

  const provider = getProvider();
  if (!provider) {
    const error = new Error("Anchor provider not initialized. Call initAnchorClient() first.");
    logger.error("Provider not initialized", error);
    throw error;
  }

  const connection = provider.connection ?? getConnection();
  const gamePubkeyObj = new PublicKey(gamePubkey);

  // Получаем keypair текущего игрока (requester)
  let requesterKeypair: Keypair | null = null;
  let requesterPubkey: PublicKey | null = null;

  if (provider.wallet) {
    requesterKeypair = (provider.wallet as unknown as { payer: Keypair }).payer;
    requesterPubkey = provider.wallet.publicKey;
  }

  if (!requesterKeypair) {
    const globalKeypair = getCurrentKeypair();
    if (globalKeypair) {
      requesterKeypair = globalKeypair;
      requesterPubkey = globalKeypair.publicKey;
    }
  }

  if (!requesterKeypair || !requesterPubkey) {
    const error = new Error("Keypair not available");
    logger.error("Keypair check failed", error);
    throw error;
  }

  logger.debug("Requester keypair retrieved", {
    requesterPubkey: requesterPubkey.toBase58(),
  });

  // Получаем состояние игры для валидации
  const gameState = await getGameState(gamePubkey);
  if (!gameState) {
    const error = new Error("Game state not found");
    logger.error("Game state check failed", error, { gamePubkey });
    throw error;
  }

  const player1Pubkey = new PublicKey(gameState.player1);
  const player2Pubkey = new PublicKey(gameState.player2);

  // Проверяем, что requester - это один из игроков
  const isPlayer1 = requesterPubkey.toBase58() === gameState.player1;
  const isPlayer2 = requesterPubkey.toBase58() === gameState.player2;

  if (!isPlayer1 && !isPlayer2) {
    const error = new Error("Requester must be one of the players");
    logger.error("Requester validation failed", error, {
      requesterPubkey: requesterPubkey.toBase58(),
      player1: gameState.player1,
      player2: gameState.player2,
    });
    throw error;
  }

  logger.info("Requester validated", {
    requesterPubkey: requesterPubkey.toBase58(),
    isPlayer1,
    isPlayer2,
  });

  // Ищем дискриминатор инструкции manual_refund
  const manualRefundIdl = (idlJson.instructions as { name: string; discriminator: number[] }[]).find(
    (ix) => ix.name === "manual_refund"
  );
  if (!manualRefundIdl) {
    const error = new Error("manual_refund instruction not found in IDL");
    logger.error("IDL lookup failed", error);
    throw error;
  }

  const discriminator = Buffer.from(manualRefundIdl.discriminator);
  const data = discriminator;

  logger.debug("Instruction data prepared", {
    discriminatorLength: discriminator.length,
    dataLength: data.length,
  });

  // Формируем инструкцию
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: gamePubkeyObj, isSigner: false, isWritable: true },
      { pubkey: player1Pubkey, isSigner: false, isWritable: true },
      { pubkey: player2Pubkey, isSigner: false, isWritable: true },
      { pubkey: requesterPubkey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);

  // Получаем recentBlockhash
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  tx.recentBlockhash = blockhash;
  tx.feePayer = requesterPubkey; // requester платит комиссию

  logger.info("Manual refund transaction created", {
    gamePubkey: gamePubkeyObj.toBase58(),
    requesterPubkey: requesterPubkey.toBase58(),
    player1Pubkey: player1Pubkey.toBase58(),
    player2Pubkey: player2Pubkey.toBase58(),
    blockhash: blockhash.substring(0, 8) + "...",
  });

  return tx;
}

