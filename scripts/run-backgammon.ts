import * as anchor from "@coral-xyz/anchor";
import { Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import { Backgammon } from "../target/types/backgammon";

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf8"));
  const secretKey = Uint8Array.from(secret);
  return Keypair.fromSecretKey(secretKey);
}

async function main() {
  // Настраиваем подключение и провайдера явно, без ANCHOR_PROVIDER_URL.
  // Используем локальный валидатор и main-authority как провайдера (payer).
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");

  const mainAuthority = loadKeypair("keys/main-authority/main-authority.json");
  const wallet = new Wallet(mainAuthority);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = anchor.workspace.Backgammon as Program<Backgammon>;

  // Игроки – заранее созданные ключи
  const player1 = loadKeypair("keys/player1/player1.json");
  const player2 = loadKeypair("keys/player2/player2.json");
  // Аккаунт игры (обычный Keypair, без PDA/seeds для упрощения)
  const game = Keypair.generate();

  // Параметры игры (в лампортах)
  const stakeLamportsNumber = 0.5 * anchor.web3.LAMPORTS_PER_SOL;
  const moveFeeLamportsNumber = 0.01 * anchor.web3.LAMPORTS_PER_SOL;

  // Минимальный баланс: ставка + 2 хода * комиссия + небольшой запас
  const minRequiredLamportsPerPlayer =
    stakeLamportsNumber + 2 * moveFeeLamportsNumber + 0.1 * anchor.web3.LAMPORTS_PER_SOL;

  for (const kp of [player1, player2]) {
    const balance = await connection.getBalance(kp.publicKey);
    if (balance < minRequiredLamportsPerPlayer) {
      const toAirdrop = minRequiredLamportsPerPlayer - balance;
      console.log(
        `Airdropping ${toAirdrop} lamports to ${kp.publicKey.toBase58()} (old balance=${balance})`
      );
      const sig = await connection.requestAirdrop(kp.publicKey, toAirdrop);
      // Для совместимости с текущей версией web3.js используем строковый overload
      await connection.confirmTransaction(sig, "confirmed");
    }
  }

  const gameId = new anchor.BN(1);
  const stakeLamports = new anchor.BN(stakeLamportsNumber);
  const moveFeeLamports = new anchor.BN(moveFeeLamportsNumber);

  // Начальное состояние доски – просто заглушка из нулей длиной 64
  const initialBoardState = new Array<number>(64).fill(0);

  // ---------------- init_game ----------------
  await program.methods
    .initGame(
      gameId,
      stakeLamports,
      moveFeeLamports,
      player2.publicKey,
      initialBoardState
    )
    .accounts({
      game: game.publicKey,
      player1: player1.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([player1, game])
    .rpc();

  console.log("Game account pubkey:", game.publicKey.toBase58());

  let gameAccount = await program.account.gameState.fetch(game.publicKey);
  console.log("After init_game:", {
    pot_lamports: gameAccount.potLamports.toString(),
    status: gameAccount.status,
    current_turn: gameAccount.currentTurn,
  });

  // ---------------- join_game ----------------
  await program.methods
      .joinGame()
      .accounts({
        game: game.publicKey,
        player2: player2.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([player2])
      .rpc();

  gameAccount = await program.account.gameState.fetch(game.publicKey);
  console.log("After join_game:", {
    pot_lamports: gameAccount.potLamports.toString(),
    status: gameAccount.status,
    current_turn: gameAccount.currentTurn,
  });

  // ---------------- make_move #1 (ходит player1) ----------------
  const boardAfterMove1 = [...initialBoardState];
  boardAfterMove1[0] = 1; // условный ход

  await program.methods
    .makeMove(boardAfterMove1)
    .accounts({
      game: game.publicKey,
      player1: player1.publicKey,
      player2: player2.publicKey,
    })
    .signers([player1, player2])
    .rpc();

  gameAccount = await program.account.gameState.fetch(game.publicKey);
  console.log("After make_move #1:", {
    pot_lamports: gameAccount.potLamports.toString(),
    status: gameAccount.status,
    current_turn: gameAccount.currentTurn,
    move_index: gameAccount.moveIndex.toString(),
  });

  // ---------------- make_move #2 (ходит player2) ----------------
  const boardAfterMove2 = [...boardAfterMove1];
  boardAfterMove2[1] = 2; // условный ход

  await program.methods
    .makeMove(boardAfterMove2)
    .accounts({
      game: game.publicKey,
      player1: player1.publicKey,
      player2: player2.publicKey,
    })
    .signers([player1, player2])
    .rpc();

  gameAccount = await program.account.gameState.fetch(game.publicKey);
  console.log("After make_move #2:", {
    pot_lamports: gameAccount.potLamports.toString(),
    status: gameAccount.status,
    current_turn: gameAccount.currentTurn,
    move_index: gameAccount.moveIndex.toString(),
  });

  // ---------------- finish_game (выиграл player1) ----------------
  await program.methods
    .finishGame(player1.publicKey)
    .accounts({
      game: game.publicKey,
      player1: player1.publicKey,
      player2: player2.publicKey,
    })
    .signers([player1, player2])
    .rpc();

  gameAccount = await program.account.gameState.fetch(game.publicKey);
  console.log("After finish_game:", {
    pot_lamports: gameAccount.potLamports.toString(),
    status: gameAccount.status,
    winner: gameAccount.winner.toBase58(),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


