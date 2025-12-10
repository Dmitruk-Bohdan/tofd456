import { useState, useEffect, useCallback } from "react";
import { getGameState } from "../solana/gameService";
import { getGame, logMove } from "../server/apiClient";
import { wsClient } from "../server/wsClient";
import { getCurrentKeypair, getProvider } from "../solana/anchorClient";
import { Logger } from "../utils/logger";
import type { WSMessage } from "../server/wsClient";
import {
  Transaction,
  TransactionInstruction,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { PROGRAM_ID } from "../solana/anchorClient";
import idlJson from "../idl/backgammon.json";

const logger = new Logger("GameScreen");

interface GameScreenProps {
  gamePubkey: string;
  onBack: () => void;
}

// Начальное состояние доски: первая ячейка -30, последняя 30, остальные 0
const INITIAL_BOARD: number[] = [
  -30,
  ...Array(22).fill(0),
  30,
];

export default function GameScreen({ gamePubkey, onBack }: GameScreenProps) {
  const [boardPoints, setBoardPoints] = useState<number[]>(INITIAL_BOARD);
  const [dice, setDice] = useState<[number, number] | null>(null);
  const [currentTurn, setCurrentTurn] = useState<number>(1); // 1 = player1, 2 = player2
  const [isMyTurn, setIsMyTurn] = useState(false);
  const [isRolling, setIsRolling] = useState(false);
  const [isProcessingMove, setIsProcessingMove] = useState(false);
  const [isProcessingFinish, setIsProcessingFinish] = useState(false);
  const [selectedCell, setSelectedCell] = useState<number | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    boardPoints: number[];
    dice: [number, number];
    moveIndex: number;
    transactionData?: number[];
  } | null>(null);
  const [pendingFinish, setPendingFinish] = useState<{
    winnerPubkey: string;
    transactionData: number[];
  } | null>(null);
  const [winnerBanner, setWinnerBanner] = useState<{
    winnerPubkey: string;
  } | null>(null);

  const provider = getProvider();
  const myPubkey = provider?.wallet?.publicKey.toBase58() || "";
  const [gameInfo, setGameInfo] = useState<{
    player1: string;
    player2: string;
  } | null>(null);

  // Загружаем информацию об игре
  useEffect(() => {
    const loadGameInfo = async () => {
      logger.info("Loading game info", { gamePubkey });
      try {
        const gameData = await getGame(gamePubkey);
        setGameInfo({
          player1: gameData.game.player1,
          player2: gameData.game.player2,
        });

        // Определяем, чей сейчас ход (по умолчанию player1 начинает)
        const isPlayer1 = myPubkey === gameData.game.player1;
        setCurrentTurn(isPlayer1 ? 1 : 2);
        setIsMyTurn(isPlayer1);

        logger.info("Game info loaded", {
          gamePubkey,
          player1: gameData.game.player1,
          player2: gameData.game.player2,
          isPlayer1,
          myPubkey,
        });
      } catch (error) {
        logger.error("Failed to load game info", error as Error, { gamePubkey });
      }
    };

    loadGameInfo();
  }, [gamePubkey, myPubkey]);

  // Загружаем состояние игры из блокчейна
  const refreshGameState = useCallback(async () => {
    logger.debug("Refreshing game state from blockchain", { gamePubkey });
    try {
      const gameState = await getGameState(gamePubkey);
      if (gameState) {
        logger.info("Game state refreshed", {
          gamePubkey,
          status: gameState.status,
          currentTurn: gameState.status === "Active" ? "Active" : "Unknown",
        });

        // Если игра активна, можно обновить текущий ход из блокчейна
        // Пока используем локальное состояние
      }
    } catch (error) {
      logger.error("Failed to refresh game state", error as Error, { gamePubkey });
    }
  }, [gamePubkey]);

  // Отправка полностью подписанной транзакции в блокчейн
  const submitSignedTransactionToBlockchain = useCallback(
    async (
      signedTx: Transaction,
      finalBoardPoints: number[],
      finalDice: [number, number]
    ) => {
      logger.info("Submitting signed transaction to blockchain", {
        gamePubkey,
        signaturesCount: signedTx.signatures.length,
        boardPoints: finalBoardPoints,
        dice: finalDice,
      });

      const provider = getProvider();
      if (!provider) {
        throw new Error("Provider not initialized");
      }

      const connection = provider.connection ?? (await import("../solana/anchorClient")).getConnection();

      try {
        logger.info("Sending transaction to Solana...");
        // Транзакция уже полностью подписана обоими игроками
        // Проверяем подписи перед отправкой
        logger.debug("Transaction signatures before serialization", {
          signaturesCount: signedTx.signatures.length,
          signatures: signedTx.signatures.map((sig, idx) => ({
            index: idx,
            publicKey: sig.publicKey.toBase58(),
            signature: sig.signature ? Buffer.from(sig.signature).toString("base64").substring(0, 16) + "..." : "null",
          })),
        });

        // Используем sendRawTransaction для отправки уже подписанной транзакции
        const serializedTx = signedTx.serialize({
          requireAllSignatures: true,
          verifySignatures: false,
        });

        logger.debug("Transaction serialized for sendRawTransaction", {
          serializedLength: serializedTx.length,
          signaturesCount: signedTx.signatures.length,
          signatures: signedTx.signatures.map((sig, idx) => ({
            index: idx,
            publicKey: sig.publicKey.toBase58(),
            signature: sig.signature ? Buffer.from(sig.signature).toString("base64").substring(0, 16) + "..." : "null",
          })),
        });

        // Проверяем, что все подписи присутствуют
        if (signedTx.signatures.length < 2) {
          const error = new Error(`Transaction missing signatures: expected 2, got ${signedTx.signatures.length}`);
          logger.error("Transaction validation failed", error, {
            signaturesCount: signedTx.signatures.length,
          });
          throw error;
        }

        // Используем maxRetries для надежности
        const signature = await connection.sendRawTransaction(serializedTx, {
          skipPreflight: false,
          maxRetries: 3,
        });

        logger.info("Transaction sent, waiting for confirmation", { signature });
        await connection.confirmTransaction(signature, "confirmed");

        logger.info("Move submitted to blockchain successfully", {
          gamePubkey,
          transactionSignature: signature,
        });

        // Обновляем локальное состояние доски и кубиков
        setBoardPoints(finalBoardPoints);
        setDice(finalDice);
        setPendingMove(null);
        setSelectedCell(null);

        // Определяем новый ход (1 -> 2, 2 -> 1)
        const newTurn = currentTurn === 1 ? 2 : 1;
        
        // Отправляем сообщение на сервер о завершении хода
        // Сервер рассылает turn_changed обоим игрокам
        logger.info("Sending turn completed to server", {
          gamePubkey,
          playerPubkey: myPubkey,
          newTurn,
        });
        wsClient.sendTurnCompleted(gamePubkey, myPubkey, newTurn);

        // Обновляем состояние из блокчейна
        await refreshGameState();
      } catch (error) {
        logger.error("Error submitting transaction to blockchain", error as Error, {
          gamePubkey,
        });
        alert("Failed to submit move to blockchain. Please try again.");
        throw error;
      }
    },
    [gamePubkey, refreshGameState, currentTurn, myPubkey]
  );

  // Отправка finish_game после двух подписей
  const submitFinishTransaction = useCallback(
    async (signedTx: Transaction, winnerPubkey: string) => {
      logger.info("Submitting finish transaction to blockchain", {
        gamePubkey,
        winnerPubkey,
        signaturesCount: signedTx.signatures.length,
      });

      const provider = getProvider();
      if (!provider) {
        throw new Error("Provider not initialized");
      }
      const connection = provider.connection ?? (await import("../solana/anchorClient")).getConnection();

      const serializedTx = signedTx.serialize({
        requireAllSignatures: true,
        verifySignatures: false,
      });

      const signature = await connection.sendRawTransaction(serializedTx, {
        skipPreflight: false,
        maxRetries: 3,
      });

      logger.info("Finish transaction sent, waiting for confirmation", { signature });
      await connection.confirmTransaction(signature, "confirmed");

      logger.info("Finish transaction confirmed", { signature, winnerPubkey });

      wsClient.sendGameFinished(gamePubkey, winnerPubkey);
      setWinnerBanner({ winnerPubkey });
      setIsMyTurn(false);
      setTimeout(() => {
        setWinnerBanner(null);
        onBack();
      }, 5000);
    },
    [gamePubkey, onBack]
  );

  // Отправка хода в блокчейн (после получения подписи от второго игрока) - fallback метод
  const submitMoveToBlockchain = useCallback(
    async (finalBoardPoints: number[], finalDice: [number, number]) => {
      logger.info("Submitting move to blockchain (fallback method)", {
        gamePubkey,
        boardPoints: finalBoardPoints,
        dice: finalDice,
      });

      try {
        // Используем submitSignedTransactionToBlockchain если есть транзакция
        // Иначе просто обновляем локальное состояние
        setBoardPoints(finalBoardPoints);
        setDice(finalDice);
        setCurrentTurn((prev) => (prev === 1 ? 2 : 1));
        setIsMyTurn((prev) => !prev);
        setPendingMove(null);
        setSelectedCell(null);

        // Обновляем состояние из блокчейна
        await refreshGameState();
      } catch (error) {
        logger.error("Error submitting move to blockchain", error as Error, {
          gamePubkey,
        });
        alert("Failed to submit move to blockchain. Please try again.");
      }
    },
    [gamePubkey, refreshGameState]
  );

  // Подписываемся на WebSocket сообщения
  useEffect(() => {
    logger.info("Setting up WebSocket handlers", { gamePubkey, myPubkey });

    if (!wsClient.isConnected()) {
      logger.debug("WebSocket not connected, connecting...");
      wsClient.connect();
    }

    wsClient.subscribe(gamePubkey, myPubkey);

    const messageHandler = async (message: WSMessage) => {
      logger.info("WebSocket message received in GameScreen", {
        messageType: message.type,
        gamePubkey: message.gamePubkey,
      });

      if (message.type === "dice_rolled" && message.gamePubkey === gamePubkey) {
        // Получены результаты броска кубиков от сервера
        logger.info("Received dice roll from server", {
          dice: message.dice,
        });

        // Обновляем кубики для обоих игроков
        if (message.dice && message.dice.length === 2) {
          setDice([message.dice[0], message.dice[1]]);
          logger.info("Dice updated from server broadcast", { dice: message.dice });
        }
      } else if (message.type === "move" && message.gamePubkey === gamePubkey) {
        // Проверяем, что это не наш собственный ход (оффчейн логирование)
        if (message.player === myPubkey) {
          logger.debug("Ignoring own move message (off-chain logging)", {
            moveIndex: message.moveIndex,
            player: message.player,
          });
          return; // Игнорируем свой собственный ход
        }

        logger.info("Received move from opponent (off-chain logging)", {
          moveIndex: message.moveIndex,
          player: message.player,
          boardPoints: message.boardPoints,
          dice: message.dice,
        });

        // Это оффчейн логирование хода, НЕ обрабатываем его как реальный ход
        // Реальный ход будет обработан через move_signed после подписания транзакции
        // Обновляем доску для отображения хода противника
        // НО НЕ обновляем кубики - они должны быть сброшены при turn_changed
        // Кубики противника не нужны новому игроку, он должен бросить свои
        if (message.boardPoints) {
          setBoardPoints(message.boardPoints);
        }
        // НЕ обновляем dice здесь - кубики будут сброшены при turn_changed
        // и новый игрок должен бросить свои кубики

        // НЕ переключаем ход здесь - это только оффчейн логирование
        // Ход будет переключен после успешной отправки в блокчейн через turn_changed
      } else if (message.type === "move_request") {
        // Запрос на подпись хода от другого игрока
        logger.info("Received move request for signature", {
          moveIndex: message.moveIndex,
          boardPoints: message.boardPoints,
          dice: message.dice,
          hasTransactionData: !!message.transactionData,
        });

        // Сохраняем как pending move
        if (message.boardPoints && message.dice && message.transactionData) {
          logger.info("Setting pending move for signature", {
            moveIndex: message.moveIndex,
            hasTransactionData: !!message.transactionData,
            transactionDataLength: message.transactionData.length,
          });
          setPendingMove({
            boardPoints: message.boardPoints,
            dice: [message.dice[0], message.dice[1]],
            moveIndex: message.moveIndex || 0,
            transactionData: message.transactionData, // Сохраняем сериализованную транзакцию
          });
          logger.info("Pending move set successfully", {
            moveIndex: message.moveIndex,
            boardPoints: message.boardPoints,
            dice: message.dice,
          });
        } else {
          logger.warn("Move request missing required data", {
            hasBoardPoints: !!message.boardPoints,
            hasDice: !!message.dice,
            hasTransactionData: !!message.transactionData,
          });
        }
      } else if (message.type === "move_signed") {
        // Ход подписан вторым игроком, можно отправлять в блокчейн
        // НО: только первый игрок (тот, кто запросил подпись) должен отправлять в блокчейн
        // Второй игрок (тот, кто подписал) не должен обрабатывать это сообщение
        
        // Проверяем, что это сообщение для нас (первого игрока, который запросил подпись)
        // Если playerPubkey в сообщении - это мы, значит мы второй игрок и не должны обрабатывать
        if (message.playerPubkey === myPubkey) {
          logger.debug("Ignoring move_signed message - we are the signer, not the requester", {
            moveIndex: message.moveIndex,
            myPubkey,
            messagePlayerPubkey: message.playerPubkey,
          });
          return; // Второй игрок не должен обрабатывать move_signed
        }

        logger.info("Received signed move, ready to submit to blockchain", {
          moveIndex: message.moveIndex,
          hasTransactionData: !!message.transactionData,
          messagePlayerPubkey: message.playerPubkey,
          myPubkey,
        });

        if (message.transactionData && message.boardPoints && message.dice) {
          // Десериализуем транзакцию
          const txBuffer = Buffer.from(message.transactionData);
          const tx = Transaction.from(txBuffer);

          logger.info("Transaction deserialized", {
            signaturesCount: tx.signatures.length,
            signatures: tx.signatures.map((sig, idx) => ({
              index: idx,
              publicKey: sig.publicKey.toBase58(),
              signature: sig.signature ? Buffer.from(sig.signature).toString("base64").substring(0, 16) + "..." : "null",
            })),
            hasRecentBlockhash: !!tx.recentBlockhash,
            recentBlockhash: tx.recentBlockhash ? tx.recentBlockhash.substring(0, 8) + "..." : "missing",
            feePayer: tx.feePayer?.toBase58() || "not set",
          });

          // Проверяем, что все подписи присутствуют
          if (tx.signatures.length < 2) {
            const error = new Error(`Transaction missing signatures: expected 2, got ${tx.signatures.length}`);
            logger.error("Transaction validation failed", error, {
              signaturesCount: tx.signatures.length,
              signatures: tx.signatures.map((sig, idx) => ({
                index: idx,
                publicKey: sig.publicKey.toBase58(),
                signature: sig.signature ? "present" : "missing",
              })),
            });
            alert("Transaction is missing signatures. Please try again.");
            return;
          }

          // Проверяем, что feePayer установлен
          if (!tx.feePayer) {
            logger.warn("Transaction missing feePayer, setting from game state");
            const gameState = await getGameState(gamePubkey);
            if (gameState) {
              tx.feePayer = new PublicKey(gameState.player1);
              logger.info("Fee payer set", { feePayer: tx.feePayer.toBase58() });
            }
          }

          // Отправляем в блокчейн (только первый игрок доходит до этого места)
          submitSignedTransactionToBlockchain(tx, message.boardPoints, [message.dice[0], message.dice[1]]).catch((error: unknown) => {
            logger.error("Error submitting signed transaction", error instanceof Error ? error : new Error(String(error)));
          });
        } else if (pendingMove) {
          // Fallback: если нет транзакции, используем старый метод
          submitMoveToBlockchain(pendingMove.boardPoints, pendingMove.dice).catch((error: unknown) => {
            logger.error("Error submitting move (fallback)", error instanceof Error ? error : new Error(String(error)));
          });
        }
      } else if (message.type === "turn_changed") {
        // Сервер уведомил о смене хода - обновляем состояние обоих игроков
        logger.info("Turn changed notification received", {
          gamePubkey: message.gamePubkey,
          newTurn: message.newTurn,
          myPubkey,
        });

        if (message.newTurn !== undefined) {
          const newTurn = message.newTurn;
          setCurrentTurn(newTurn);
          
          // Определяем, наш ли это ход
          // Если gameInfo ещё не загружен, используем текущий myPubkey
          if (gameInfo) {
            const isPlayer1 = myPubkey === gameInfo.player1;
            const isMyTurnNow = (newTurn === 1 && isPlayer1) || (newTurn === 2 && !isPlayer1);
            setIsMyTurn(isMyTurnNow);

            logger.info("Turn state updated", {
              newTurn,
              isMyTurn: isMyTurnNow,
              isPlayer1,
            });
          } else {
            // Если gameInfo ещё не загружен, просто обновляем currentTurn
            // isMyTurn будет обновлён позже, когда gameInfo загрузится
            logger.info("Turn state updated (gameInfo not loaded yet)", {
              newTurn,
            });
          }

          // Сбрасываем состояние для нового хода
          // Новый игрок должен бросить новые кубики
          setDice(null);
          setSelectedCell(null);
          setPendingMove(null);
          setIsRolling(false);
          setIsProcessingMove(false);

          // Обновляем состояние игры из блокчейна, чтобы получить актуальное состояние доски
          refreshGameState().catch((error: unknown) => {
            logger.error("Failed to refresh game state after turn change", error instanceof Error ? error : new Error(String(error)));
          });

          logger.info("Game state reset for new turn", {
            newTurn,
            diceCleared: true,
            selectedCellCleared: true,
            pendingMoveCleared: true,
          });
        }
      } else if (message.type === "finish_request" && message.gamePubkey === gamePubkey) {
        logger.info("Received finish request for signature", {
          winnerPubkey: message.winnerPubkey,
          hasTransactionData: !!message.transactionData,
        });

        if (message.transactionData && message.winnerPubkey) {
          setPendingFinish({
            winnerPubkey: message.winnerPubkey,
            transactionData: message.transactionData,
          });
          logger.info("Pending finish set successfully", {
            winnerPubkey: message.winnerPubkey,
            transactionDataLength: message.transactionData.length,
          });
        }
      } else if (message.type === "finish_signed" && message.gamePubkey === gamePubkey) {
        // Только инициатор (не signer) должен обработать
        if (message.playerPubkey === myPubkey) {
          logger.debug("Ignoring finish_signed - we are the signer");
          return;
        }

        logger.info("Received signed finish, submitting to blockchain", {
          winnerPubkey: message.winnerPubkey,
          hasTransactionData: !!message.transactionData,
        });

        if (message.transactionData && message.winnerPubkey) {
          const txBuffer = Buffer.from(message.transactionData);
          const tx = Transaction.from(txBuffer);

          logger.info("Finish transaction deserialized", {
            signaturesCount: tx.signatures.length,
            signatures: tx.signatures.map((sig, idx) => ({
              index: idx,
              publicKey: sig.publicKey.toBase58(),
              signature: sig.signature ? Buffer.from(sig.signature).toString("base64").substring(0, 16) + "..." : "null",
            })),
          });

          submitFinishTransaction(tx, message.winnerPubkey).catch((error: unknown) => {
            logger.error("Error submitting finish transaction", error instanceof Error ? error : new Error(String(error)));
          });
        }
      } else if (message.type === "game_finished" && message.gamePubkey === gamePubkey) {
        logger.info("Game finished notification received", {
          winner: message.winnerPubkey,
        });
        setWinnerBanner({ winnerPubkey: message.winnerPubkey || "Unknown" });
        setIsMyTurn(false);
        setTimeout(() => {
          setWinnerBanner(null);
          onBack();
        }, 5000);
      }
    };

    wsClient.onMessage(messageHandler);

    return () => {
      logger.debug("Cleaning up WebSocket handlers");
      wsClient.offMessage(messageHandler);
    };
    // НЕ включаем pendingMove в зависимости, чтобы не пересоздавать handlers при его изменении
    // pendingMove используется внутри handler через замыкание
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gamePubkey, myPubkey, submitMoveToBlockchain, submitSignedTransactionToBlockchain, submitFinishTransaction, refreshGameState, gameInfo]);

  // Бросок кубиков
  const rollDice = useCallback(async () => {
    if (isRolling || !isMyTurn) return;

    logger.info("Rolling dice", { gamePubkey, isMyTurn });
    setIsRolling(true);

    try {
      const response = await fetch(`http://localhost:3001/api/games/${gamePubkey}/roll-dice`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Failed to roll dice: ${response.statusText}`);
      }

      const data = await response.json();
      const rolledDice: [number, number] = [data.dice[0], data.dice[1]];

      logger.info("Dice rolled successfully", { dice: rolledDice });
      setDice(rolledDice);
      setSelectedCell(null);
    } catch (error) {
      logger.error("Error rolling dice", error as Error, { gamePubkey });
      alert("Failed to roll dice. Please try again.");
    } finally {
      setIsRolling(false);
    }
  }, [gamePubkey, isMyTurn, isRolling]);

  // Выбор ячейки для хода
  const handleCellClick = useCallback(
    (index: number) => {
      if (!isMyTurn || !dice || isProcessingMove) return;

      logger.debug("Cell clicked", { index, currentValue: boardPoints[index] });

      setSelectedCell(index);
    },
    [isMyTurn, dice, isProcessingMove, boardPoints]
  );

  // Формирование транзакции make_move
  const createMoveTransaction = useCallback(
    async (
      newBoardPoints: number[],
      newDice: [number, number]
    ): Promise<Transaction> => {
      logger.info("Creating move transaction", {
        gamePubkey,
        boardPoints: newBoardPoints,
        dice: newDice,
      });

      const provider = getProvider();
      if (!provider) {
        throw new Error("Provider not initialized");
      }

      const connection = provider.connection ?? (await import("../solana/anchorClient")).getConnection();

      const gameState = await getGameState(gamePubkey);
      if (!gameState) {
        throw new Error("Game state not found");
      }

      const player1Pubkey = new PublicKey(gameState.player1);
      const player2Pubkey = new PublicKey(gameState.player2);
      const gamePubkeyObj = new PublicKey(gamePubkey);

      // Формируем data для инструкции make_move
      const makeMoveIdl = (idlJson.instructions as { name: string; discriminator: number[] }[]).find(
        (ix) => ix.name === "make_move"
      );
      if (!makeMoveIdl) {
        throw new Error("make_move instruction not found in IDL");
      }

      const discriminator = Buffer.from(makeMoveIdl.discriminator);

      // Конвертируем boardPoints в i8 массив
      const boardPointsBuffer = Buffer.alloc(24);
      for (let i = 0; i < 24; i++) {
        const value = Math.max(-128, Math.min(127, newBoardPoints[i]));
        boardPointsBuffer.writeInt8(value, i);
      }

      const diceBuffer = Buffer.from(newDice);
      const data = Buffer.concat([discriminator, boardPointsBuffer, diceBuffer]);

      logger.debug("Instruction data prepared", {
        dataLength: data.length,
        boardPoints: newBoardPoints,
        dice: newDice,
      });

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

      // Получаем recentBlockhash перед подписанием
      logger.debug("Fetching recent blockhash for transaction");
      const { blockhash } = await connection.getLatestBlockhash("finalized");
      tx.recentBlockhash = blockhash;
      tx.feePayer = player1Pubkey; // Устанавливаем fee payer (может быть любой из игроков)

      logger.info("Transaction created with recentBlockhash", {
        gamePubkey: gamePubkeyObj.toBase58(),
        player1Pubkey: player1Pubkey.toBase58(),
        player2Pubkey: player2Pubkey.toBase58(),
        blockhash: blockhash.substring(0, 8) + "...",
      });

      return tx;
    },
    [gamePubkey]
  );

  // Формирование транзакции finish_game
  const createFinishTransaction = useCallback(
    async (winnerPubkey: PublicKey): Promise<Transaction> => {
      logger.info("Creating finish transaction", {
        gamePubkey,
        winner: winnerPubkey.toBase58(),
      });

      const provider = getProvider();
      if (!provider) {
        throw new Error("Provider not initialized");
      }

      const connection = provider.connection ?? (await import("../solana/anchorClient")).getConnection();

      const gameState = await getGameState(gamePubkey);
      if (!gameState) {
        throw new Error("Game state not found");
      }

      const player1Pubkey = new PublicKey(gameState.player1);
      const player2Pubkey = new PublicKey(gameState.player2);
      const gamePubkeyObj = new PublicKey(gamePubkey);

      const finishIdl = (idlJson.instructions as { name: string; discriminator: number[] }[]).find(
        (ix) => ix.name === "finish_game"
      );
      if (!finishIdl) {
        throw new Error("finish_game instruction not found in IDL");
      }

      const discriminator = Buffer.from(finishIdl.discriminator);
      const data = Buffer.concat([discriminator, winnerPubkey.toBuffer()]);

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
      const { blockhash } = await connection.getLatestBlockhash("finalized");
      tx.recentBlockhash = blockhash;
      tx.feePayer = winnerPubkey;

      logger.info("Finish transaction created with recentBlockhash", {
        gamePubkey: gamePubkeyObj.toBase58(),
        winner: winnerPubkey.toBase58(),
        blockhash: blockhash.substring(0, 8) + "...",
      });

      return tx;
    },
    [gamePubkey]
  );

  // Подтверждение хода
  const confirmMove = useCallback(async () => {
    if (!isMyTurn || !dice || selectedCell === null || isProcessingMove) return;

    logger.info("Confirming move", {
      gamePubkey,
      selectedCell,
      currentValue: boardPoints[selectedCell],
      dice,
    });

    setIsProcessingMove(true);

    try {
      const provider = getProvider();
      if (!provider) {
        throw new Error("Provider not initialized");
      }

      const myKeypair = getCurrentKeypair();
      if (!myKeypair) {
        throw new Error("Keypair not available");
      }

      // Создаём новое состояние доски
      const newBoardPoints = [...boardPoints];
      const change = newBoardPoints[selectedCell] >= 0 ? -1 : 1;
      newBoardPoints[selectedCell] += change;

      logger.info("New board state calculated", {
        cellIndex: selectedCell,
        oldValue: boardPoints[selectedCell],
        newValue: newBoardPoints[selectedCell],
        change,
      });

      // Получаем текущий move_index
      const gameData = await getGame(gamePubkey);
      const moveIndex = (gameData.moves?.length || 0) + 1;

      // Формируем транзакцию
      const tx = await createMoveTransaction(newBoardPoints, dice);

      // Подписываем транзакцию своей подписью (partialSign, чтобы не затирать чужие подписи)
      tx.partialSign(myKeypair);
      logger.info("Transaction signed by me", {
        myPubkey: myKeypair.publicKey.toBase58(),
        signaturesCount: tx.signatures.length,
        signatures: tx.signatures.map((sig, idx) => ({
          index: idx,
          publicKey: sig.publicKey.toBase58(),
          signature: sig.signature ? Buffer.from(sig.signature).toString("base64").substring(0, 16) + "..." : "null",
        })),
      });

      // Сериализуем транзакцию для отправки через WS
      // Используем requireAllSignatures: false, так как второй игрок еще не подписал
      const serializedTx = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });

      logger.debug("Transaction serialized for WebSocket (first player signature only)", {
        serializedLength: serializedTx.length,
        signaturesCount: tx.signatures.length,
      });

      logger.info("Transaction serialized", {
        serializedLength: serializedTx.length,
      });

      // Отправляем запрос на подпись второму игроку через WS
      const moveRequest: WSMessage = {
        type: "move_request",
        gamePubkey,
        playerPubkey: myPubkey,
        moveIndex,
        boardPoints: newBoardPoints,
        dice,
        transactionData: Array.from(serializedTx), // Сериализованная транзакция
      };

      logger.info("Sending move request to opponent via WebSocket", {
        moveRequest: {
          ...moveRequest,
          transactionData: `[${serializedTx.length} bytes]`,
        },
      });

      wsClient.sendMoveRequest(gamePubkey, moveRequest);

      // Сохраняем как pending move
      setPendingMove({
        boardPoints: newBoardPoints,
        dice,
        moveIndex,
      });

      // Логируем ход на сервере (оффчейн)
      await logMove(gamePubkey, {
        moveIndex,
        player: myPubkey,
        boardPoints: newBoardPoints,
        dice,
      });

      logger.info("Move logged on server", { gamePubkey, moveIndex });
    } catch (error) {
      logger.error("Error confirming move", error as Error, {
        gamePubkey,
        selectedCell,
        dice,
      });
      alert("Failed to make move. Please try again.");
    } finally {
      setIsProcessingMove(false);
      setSelectedCell(null);
    }
  }, [isMyTurn, dice, selectedCell, boardPoints, gamePubkey, myPubkey, isProcessingMove, createMoveTransaction]);

  // Завершение игры (кнопка "Я выиграл")
  const confirmWin = useCallback(async () => {
    if (!isMyTurn || isProcessingFinish) return;

    logger.info("Confirming win", { gamePubkey, myPubkey });
    setIsProcessingFinish(true);

    try {
      const myPubkeyObj = new PublicKey(myPubkey);
      const tx = await createFinishTransaction(myPubkeyObj);

      const myKeypair = getCurrentKeypair();
      if (!myKeypair) {
        throw new Error("Keypair not found");
      }
      tx.partialSign(myKeypair);

      logger.info("Finish transaction signed by me", {
        myPubkey,
        signaturesCount: tx.signatures.length,
        signatures: tx.signatures.map((sig, idx) => ({
          index: idx,
          publicKey: sig.publicKey.toBase58(),
          signature: sig.signature ? Buffer.from(sig.signature).toString("base64").substring(0, 16) + "..." : "null",
        })),
      });

      const serializedTx = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      logger.info("Finish transaction serialized", { serializedLength: serializedTx.length });

      const finishRequest: WSMessage = {
        type: "finish_request",
        gamePubkey,
        playerPubkey: myPubkey,
        transactionData: Array.from(serializedTx),
        winnerPubkey: myPubkey,
      };

      logger.info("Sending finish request to opponent via WebSocket", { finishRequest });
      wsClient.sendFinishRequest(gamePubkey, finishRequest);

      setPendingFinish({
        winnerPubkey: myPubkey,
        transactionData: Array.from(serializedTx),
      });

      setIsProcessingFinish(false);
    } catch (error) {
      logger.error("Error confirming win", error as Error, { gamePubkey });
      alert("Failed to confirm win. Please try again.");
      setIsProcessingFinish(false);
    }
  }, [createFinishTransaction, gamePubkey, isMyTurn, isProcessingFinish, myPubkey]);


  // Обработка pending move (когда пришёл запрос на подпись)
  const handlePendingMoveSignature = useCallback(async () => {
    if (!pendingMove || !pendingMove.transactionData) return;

    logger.info("Signing pending move", {
      gamePubkey,
      pendingMove: {
        ...pendingMove,
        transactionData: `[${pendingMove.transactionData.length} bytes]`,
      },
      myPubkey,
    });

    try {
      const myKeypair = getCurrentKeypair();
      if (!myKeypair) {
        throw new Error("Keypair not available");
      }

      // Десериализуем транзакцию
      const txBuffer = Buffer.from(pendingMove.transactionData);
      const tx = Transaction.from(txBuffer);

      logger.info("Transaction deserialized for signing", {
        signaturesCount: tx.signatures.length,
        hasRecentBlockhash: !!tx.recentBlockhash,
        recentBlockhash: tx.recentBlockhash ? tx.recentBlockhash.substring(0, 8) + "..." : "missing",
        signatures: tx.signatures.map((sig, idx) => ({
          index: idx,
          publicKey: sig.publicKey.toBase58(),
          signature: sig.signature ? Buffer.from(sig.signature).toString("base64").substring(0, 16) + "..." : "null",
        })),
      });

      // Проверяем, что recentBlockhash установлен (он должен быть уже установлен отправителем)
      if (!tx.recentBlockhash) {
        logger.warn("Transaction missing recentBlockhash, fetching new one");
        const provider = getProvider();
        if (!provider) {
          throw new Error("Provider not initialized");
        }
        const connection = provider.connection ?? (await import("../solana/anchorClient")).getConnection();
        const { blockhash } = await connection.getLatestBlockhash("finalized");
        tx.recentBlockhash = blockhash;
        logger.info("Recent blockhash set", { blockhash: blockhash.substring(0, 8) + "..." });
      }

      // Подписываем транзакцию своей подписью (partialSign, чтобы не затирать подпись первого игрока)
      // ВАЖНО: подпись добавляется к существующим подписям, не заменяет их
      tx.partialSign(myKeypair);

      logger.info("Transaction signed by me", {
        myPubkey: myKeypair.publicKey.toBase58(),
        signaturesCount: tx.signatures.length,
        signatures: tx.signatures.map((sig, idx) => ({
          index: idx,
          publicKey: sig.publicKey.toBase58(),
          signature: sig.signature ? Buffer.from(sig.signature).toString("base64").substring(0, 16) + "..." : "null",
        })),
      });

      // Сериализуем подписанную транзакцию
      const serializedTx = tx.serialize({
        requireAllSignatures: true,
        verifySignatures: false,
      });

      logger.info("Signed transaction serialized", {
        serializedLength: serializedTx.length,
      });

      // Отправляем обратно через WS
      const signedMove: WSMessage = {
        type: "move_signed",
        gamePubkey,
        playerPubkey: myPubkey,
        moveIndex: pendingMove.moveIndex,
        boardPoints: pendingMove.boardPoints,
        dice: pendingMove.dice,
        transactionData: Array.from(serializedTx),
      };

      logger.info("Sending signed move back to requester", {
        signedMove: {
          ...signedMove,
          transactionData: `[${serializedTx.length} bytes]`,
        },
      });

      wsClient.sendMoveSigned(gamePubkey, signedMove);

      setPendingMove(null);
    } catch (error) {
      logger.error("Error signing pending move", error as Error, {
        gamePubkey,
        pendingMove: pendingMove ? {
          ...pendingMove,
          transactionData: pendingMove.transactionData ? `[${pendingMove.transactionData.length} bytes]` : undefined,
        } : null,
      });
      alert("Failed to sign move. Please try again.");
    }
  }, [pendingMove, gamePubkey, myPubkey]);

  // Обработка pending finish (подписание победы вторым игроком)
  const handlePendingFinishSignature = useCallback(async () => {
    if (!pendingFinish || !pendingFinish.transactionData) return;

    logger.info("Signing pending finish", {
      gamePubkey,
      pendingFinish: {
        ...pendingFinish,
        transactionData: `[${pendingFinish.transactionData.length} bytes]`,
      },
      myPubkey,
    });

    try {
      const myKeypair = getCurrentKeypair();
      if (!myKeypair) {
        throw new Error("Keypair not available");
      }

      const txBuffer = Buffer.from(pendingFinish.transactionData);
      const tx = Transaction.from(txBuffer);

      if (!tx.recentBlockhash) {
        const provider = getProvider();
        if (!provider) throw new Error("Provider not initialized");
        const connection = provider.connection ?? (await import("../solana/anchorClient")).getConnection();
        const { blockhash } = await connection.getLatestBlockhash("finalized");
        tx.recentBlockhash = blockhash;
      }

      tx.partialSign(myKeypair);

      logger.info("Finish transaction signed by me", {
        myPubkey: myKeypair.publicKey.toBase58(),
        signaturesCount: tx.signatures.length,
        signatures: tx.signatures.map((sig, idx) => ({
          index: idx,
          publicKey: sig.publicKey.toBase58(),
          signature: sig.signature ? Buffer.from(sig.signature).toString("base64").substring(0, 16) + "..." : "null",
        })),
      });

      const serializedTx = tx.serialize({ requireAllSignatures: true, verifySignatures: false });
      logger.info("Signed finish serialized", { serializedLength: serializedTx.length });

      const signedMessage: WSMessage = {
        type: "finish_signed",
        gamePubkey,
        playerPubkey: myPubkey,
        transactionData: Array.from(serializedTx),
        winnerPubkey: pendingFinish.winnerPubkey,
      };

      wsClient.sendFinishSigned(gamePubkey, signedMessage);
      setPendingFinish(null);
    } catch (error) {
      logger.error("Error signing pending finish", error as Error, { gamePubkey });
      alert("Failed to sign finish. Please try again.");
    }
  }, [gamePubkey, myPubkey, pendingFinish]);

  // Автоподпись pending finish, когда это не наш ход (мы второй подписант)
  useEffect(() => {
    if (!isMyTurn && pendingFinish) {
      handlePendingFinishSignature();
    }
  }, [handlePendingFinishSignature, isMyTurn, pendingFinish]);

  return (
    <div style={{ width: "100%", padding: "40px", backgroundColor: "white" }}>
      <div style={{ marginBottom: "20px" }}>
        <button
          onClick={onBack}
          style={{
            padding: "10px 20px",
            backgroundColor: "#6c757d",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          ← Back to Menu
        </button>
      </div>

      {winnerBanner && (
        <div
          style={{
            padding: "16px",
            backgroundColor: "#d4edda",
            border: "2px solid #28a745",
            borderRadius: "6px",
            color: "#155724",
            marginBottom: "16px",
            fontSize: "18px",
            fontWeight: "bold",
          }}
        >
          Победил: {winnerBanner.winnerPubkey.substring(0, 8)}...
        </div>
      )}

      <h2 style={{ color: "#000", marginBottom: "20px" }}>Game: {gamePubkey.substring(0, 8)}...</h2>

      {gameInfo && (
        <div style={{ marginBottom: "20px", color: "#000" }}>
          <div>
            <strong>Player 1:</strong> {gameInfo.player1.substring(0, 8)}...
            {currentTurn === 1 && " ← Your turn"}
          </div>
          <div>
            <strong>Player 2:</strong> {gameInfo.player2.substring(0, 8)}...
            {currentTurn === 2 && " ← Your turn"}
          </div>
        </div>
      )}

      {/* Игровое поле - 24 ячейки */}
      <div style={{ marginBottom: "30px" }}>
        <h3 style={{ color: "#000", marginBottom: "15px" }}>Board (24 cells)</h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(6, 1fr)",
            gap: "10px",
            marginBottom: "20px",
          }}
        >
          {boardPoints.map((value, index) => (
            <div
              key={index}
              onClick={() => handleCellClick(index)}
              style={{
                padding: "20px",
                border: selectedCell === index ? "3px solid #007bff" : "2px solid #ccc",
                borderRadius: "4px",
                textAlign: "center",
                cursor: isMyTurn && dice ? "pointer" : "default",
                backgroundColor: selectedCell === index ? "#e3f2fd" : "white",
                color: "#000",
                fontWeight: selectedCell === index ? "bold" : "normal",
              }}
            >
              <div style={{ fontSize: "12px", marginBottom: "5px", color: "#666" }}>
                Cell {index}
              </div>
              <div style={{ fontSize: "20px" }}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Кубики */}
      {dice && (
        <div style={{ marginBottom: "20px", color: "#000" }}>
          <h3>Dice</h3>
          <div style={{ display: "flex", gap: "10px" }}>
            <div
              style={{
                padding: "15px",
                border: "2px solid #ccc",
                borderRadius: "4px",
                fontSize: "24px",
                backgroundColor: "white",
              }}
            >
              {dice[0]}
            </div>
            <div
              style={{
                padding: "15px",
                border: "2px solid #ccc",
                borderRadius: "4px",
                fontSize: "24px",
                backgroundColor: "white",
              }}
            >
              {dice[1]}
            </div>
          </div>
        </div>
      )}

      {/* Кнопки управления */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "20px", flexWrap: "wrap" }}>
        {!dice && isMyTurn && (
          <button
            onClick={rollDice}
            disabled={isRolling}
            style={{
              padding: "12px 24px",
              fontSize: "16px",
              backgroundColor: isRolling ? "#ccc" : "#007bff",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: isRolling ? "not-allowed" : "pointer",
            }}
          >
            {isRolling ? "Rolling..." : "Roll Dice"}
          </button>
        )}

        {dice && selectedCell !== null && isMyTurn && (
          <button
            onClick={confirmMove}
            disabled={isProcessingMove}
            style={{
              padding: "12px 24px",
              fontSize: "16px",
              backgroundColor: isProcessingMove ? "#ccc" : "#28a745",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: isProcessingMove ? "not-allowed" : "pointer",
            }}
          >
            {isProcessingMove ? "Processing..." : "Confirm Move"}
          </button>
        )}

        {isMyTurn && (
          <button
            onClick={confirmWin}
            disabled={isProcessingFinish}
            style={{
              padding: "12px 24px",
              fontSize: "16px",
              backgroundColor: isProcessingFinish ? "#ccc" : "#d9534f",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: isProcessingFinish ? "not-allowed" : "pointer",
            }}
          >
            {isProcessingFinish ? "Processing..." : "Я выиграл"}
          </button>
        )}
      </div>

      {/* Pending move для подписи */}
      {pendingMove && !isMyTurn && (
        <div
          style={{
            padding: "20px",
            backgroundColor: "#fff3cd",
            border: "2px solid #ffc107",
            borderRadius: "4px",
            marginBottom: "20px",
          }}
        >
          <h3 style={{ color: "#000", marginBottom: "10px" }}>Pending Move to Sign</h3>
          <p style={{ color: "#000", marginBottom: "10px" }}>
            Opponent wants to make a move. Please review and sign.
          </p>
          <div style={{ marginBottom: "10px", color: "#000" }}>
            <strong>Dice:</strong> {pendingMove.dice[0]}, {pendingMove.dice[1]}
          </div>
          <button
            onClick={handlePendingMoveSignature}
            style={{
              padding: "10px 20px",
              backgroundColor: "#28a745",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Sign & Approve Move
          </button>
        </div>
      )}

      {pendingFinish && !isMyTurn && (
        <div
          style={{
            padding: "20px",
            backgroundColor: "#ffeaea",
            border: "2px solid #dc3545",
            borderRadius: "4px",
            marginBottom: "20px",
          }}
        >
          <h3 style={{ color: "#000", marginBottom: "10px" }}>Finish Request to Sign</h3>
          <p style={{ color: "#000", marginBottom: "10px" }}>
            Opponent claims victory. Please verify and sign if correct.
          </p>
          <div style={{ marginBottom: "10px", color: "#000" }}>
            <strong>Winner:</strong> {pendingFinish.winnerPubkey.substring(0, 8)}...
          </div>
          <button
            onClick={handlePendingFinishSignature}
            style={{
              padding: "10px 20px",
              backgroundColor: "#dc3545",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Sign & Approve Finish
          </button>
        </div>
      )}

      {!isMyTurn && !pendingMove && (
        <div style={{ color: "#666", fontStyle: "italic" }}>
          Waiting for opponent's move...
        </div>
      )}
    </div>
  );
}

