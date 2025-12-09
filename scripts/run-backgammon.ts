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

  const program: any = anchor.workspace.Backgammon as Program<Backgammon>;

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

  // Начальное состояние доски – просто заглушка из нулей длиной 24
  const initialBoardPoints = new Array<number>(24).fill(0);

  // ---------------- init_game ----------------
  await program.methods
    .initGame(gameId, stakeLamports, moveFeeLamports, player2.publicKey)
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
  const balance1_after_init = await connection.getBalance(player1.publicKey);
  const balance2_after_init = await connection.getBalance(player2.publicKey);
  console.log("Player balances after init_game:", {
    player1: `${balance1_after_init / anchor.web3.LAMPORTS_PER_SOL} SOL`,
    player2: `${balance2_after_init / anchor.web3.LAMPORTS_PER_SOL} SOL`,
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
  const balance1_after_join = await connection.getBalance(player1.publicKey);
  const balance2_after_join = await connection.getBalance(player2.publicKey);
  console.log("Player balances after join_game:", {
    player1: `${balance1_after_join / anchor.web3.LAMPORTS_PER_SOL} SOL`,
    player2: `${balance2_after_join / anchor.web3.LAMPORTS_PER_SOL} SOL`,
  });

  // ---------------- make_move #1 (ходит player1) ----------------
  const boardAfterMove1 = [...initialBoardPoints];
  boardAfterMove1[0] = 1; // условный ход
  const diceAfterMove1 = [3, 5];

  await program.methods
    .makeMove(boardAfterMove1, diceAfterMove1)
    .accounts({
      game: game.publicKey,
      player1: player1.publicKey,
      player2: player2.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([player1, player2])
    .rpc();

  gameAccount = await program.account.gameState.fetch(game.publicKey);
  console.log("After make_move #1:", {
    pot_lamports: gameAccount.potLamports.toString(),
    status: gameAccount.status,
    current_turn: gameAccount.currentTurn,
    move_index: gameAccount.moveIndex.toString(),
  });
  const balance1_after_move1 = await connection.getBalance(player1.publicKey);
  const balance2_after_move1 = await connection.getBalance(player2.publicKey);
  console.log("Player balances after make_move #1:", {
    player1: `${balance1_after_move1 / anchor.web3.LAMPORTS_PER_SOL} SOL`,
    player2: `${balance2_after_move1 / anchor.web3.LAMPORTS_PER_SOL} SOL`,
  });

  // ---------------- make_move #2 (ходит player2) ----------------
  const boardAfterMove2 = [...boardAfterMove1];
  boardAfterMove2[1] = 2; // условный ход
  const diceAfterMove2 = [2, 6];

  await program.methods
    .makeMove(boardAfterMove2, diceAfterMove2)
    .accounts({
      game: game.publicKey,
      player1: player1.publicKey,
      player2: player2.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([player1, player2])
    .rpc();

  gameAccount = await program.account.gameState.fetch(game.publicKey);
  console.log("After make_move #2:", {
    pot_lamports: gameAccount.potLamports.toString(),
    status: gameAccount.status,
    current_turn: gameAccount.currentTurn,
    move_index: gameAccount.moveIndex.toString(),
  });
  const balance1_after_move2 = await connection.getBalance(player1.publicKey);
  const balance2_after_move2 = await connection.getBalance(player2.publicKey);
  console.log("Player balances after make_move #2:", {
    player1: `${balance1_after_move2 / anchor.web3.LAMPORTS_PER_SOL} SOL`,
    player2: `${balance2_after_move2 / anchor.web3.LAMPORTS_PER_SOL} SOL`,
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
  const balance1_after_finish = await connection.getBalance(player1.publicKey);
  const balance2_after_finish = await connection.getBalance(player2.publicKey);
  console.log("Player balances after finish_game:", {
    player1: `${balance1_after_finish / anchor.web3.LAMPORTS_PER_SOL} SOL`,
    player2: `${balance2_after_finish / anchor.web3.LAMPORTS_PER_SOL} SOL`,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


