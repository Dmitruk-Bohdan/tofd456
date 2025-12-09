import * as anchor from "@coral-xyz/anchor";
import { Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import { Backgammon } from "../target/types/backgammon";

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf8"));
  const secretKey = Uint8Array.from(secret);
  return Keypair.fromSecretKey(secretKey);
}

async function main() {
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");

  const mainAuthority = loadKeypair("keys/main-authority/main-authority.json");
  const wallet = new Wallet(mainAuthority);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = anchor.workspace.Backgammon as Program<Backgammon>;

  const player1 = loadKeypair("keys/player1/player1.json");
  const player2 = loadKeypair("keys/player2/player2.json");
  const game = Keypair.generate();

  const stakeLamportsNumber = 0.5 * anchor.web3.LAMPORTS_PER_SOL;
  const moveFeeLamportsNumber = 0.01 * anchor.web3.LAMPORTS_PER_SOL;

  const minRequiredLamportsPerPlayer =
    stakeLamportsNumber + 3 * moveFeeLamportsNumber + 0.1 * anchor.web3.LAMPORTS_PER_SOL;

  // Пополняем игроков при необходимости
  for (const kp of [player1, player2]) {
    const balance = await connection.getBalance(kp.publicKey);
    if (balance < minRequiredLamportsPerPlayer) {
      const toAirdrop = minRequiredLamportsPerPlayer - balance;
      console.log(
        `Airdropping ${toAirdrop} lamports to ${kp.publicKey.toBase58()} (old balance=${balance})`
      );
      const sig = await connection.requestAirdrop(kp.publicKey, toAirdrop);
      await connection.confirmTransaction(sig, "confirmed");
    }
  }

  const balance1_before = await connection.getBalance(player1.publicKey);
  const balance2_before = await connection.getBalance(player2.publicKey);
  console.log("Initial player balances:", {
    player1: balance1_before / anchor.web3.LAMPORTS_PER_SOL,
    player2: balance2_before / anchor.web3.LAMPORTS_PER_SOL,
  });

  const gameId = new anchor.BN(1);
  const stakeLamports = new anchor.BN(stakeLamportsNumber);
  const moveFeeLamports = new anchor.BN(moveFeeLamportsNumber);

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
    pot_sol: Number(gameAccount.potLamports) / anchor.web3.LAMPORTS_PER_SOL,
    status: gameAccount.status,
    current_turn: gameAccount.currentTurn,
  });
  let p1_balance = await connection.getBalance(player1.publicKey);
  let p2_balance = await connection.getBalance(player2.publicKey);
  console.log("Player balances after init_game:", {
    player1: p1_balance / anchor.web3.LAMPORTS_PER_SOL,
    player2: p2_balance / anchor.web3.LAMPORTS_PER_SOL,
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
    pot_sol: Number(gameAccount.potLamports) / anchor.web3.LAMPORTS_PER_SOL,
    status: gameAccount.status,
    current_turn: gameAccount.currentTurn,
  });
  p1_balance = await connection.getBalance(player1.publicKey);
  p2_balance = await connection.getBalance(player2.publicKey);
  console.log("Player balances after join_game:", {
    player1: p1_balance / anchor.web3.LAMPORTS_PER_SOL,
    player2: p2_balance / anchor.web3.LAMPORTS_PER_SOL,
  });

  // ---------------- make_move #1 (ходит player1) ----------------
  const boardAfterMove1 = [...initialBoardState];
  boardAfterMove1[0] = 1;

  await program.methods
    .makeMove(boardAfterMove1)
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
    pot_sol: Number(gameAccount.potLamports) / anchor.web3.LAMPORTS_PER_SOL,
    status: gameAccount.status,
    current_turn: gameAccount.currentTurn,
    move_index: gameAccount.moveIndex.toString(),
  });
  p1_balance = await connection.getBalance(player1.publicKey);
  p2_balance = await connection.getBalance(player2.publicKey);
  console.log("Player balances after make_move #1:", {
    player1: p1_balance / anchor.web3.LAMPORTS_PER_SOL,
    player2: p2_balance / anchor.web3.LAMPORTS_PER_SOL,
  });

  // ---------------- make_move #2 (ходит player2) ----------------
  const boardAfterMove2 = [...boardAfterMove1];
  boardAfterMove2[1] = 2;

  await program.methods
    .makeMove(boardAfterMove2)
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
    pot_sol: Number(gameAccount.potLamports) / anchor.web3.LAMPORTS_PER_SOL,
    status: gameAccount.status,
    current_turn: gameAccount.currentTurn,
    move_index: gameAccount.moveIndex.toString(),
  });
  p1_balance = await connection.getBalance(player1.publicKey);
  p2_balance = await connection.getBalance(player2.publicKey);
  console.log("Player balances after make_move #2:", {
    player1: p1_balance / anchor.web3.LAMPORTS_PER_SOL,
    player2: p2_balance / anchor.web3.LAMPORTS_PER_SOL,
  });

  // ---------------- make_move #3 (снова player1) ----------------
  const boardAfterMove3 = [...boardAfterMove2];
  boardAfterMove3[2] = 3;

  await program.methods
    .makeMove(boardAfterMove3)
    .accounts({
      game: game.publicKey,
      player1: player1.publicKey,
      player2: player2.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([player1, player2])
    .rpc();

  gameAccount = await program.account.gameState.fetch(game.publicKey);
  console.log("After make_move #3:", {
    pot_sol: Number(gameAccount.potLamports) / anchor.web3.LAMPORTS_PER_SOL,
    status: gameAccount.status,
    current_turn: gameAccount.currentTurn,
    move_index: gameAccount.moveIndex.toString(),
  });
  p1_balance = await connection.getBalance(player1.publicKey);
  p2_balance = await connection.getBalance(player2.publicKey);
  console.log("Player balances after make_move #3:", {
    player1: p1_balance / anchor.web3.LAMPORTS_PER_SOL,
    player2: p2_balance / anchor.web3.LAMPORTS_PER_SOL,
  });

  // ---------------- manual_refund (оба игрока согласны отменить игру) ----------------
  await program.methods
    .manualRefund()
    .accounts({
      game: game.publicKey,
      player1: player1.publicKey,
      player2: player2.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([player1, player2])
    .rpc();

  gameAccount = await program.account.gameState.fetch(game.publicKey);
  console.log("After manual_refund:", {
    pot_sol: Number(gameAccount.potLamports) / anchor.web3.LAMPORTS_PER_SOL,
    status: gameAccount.status,
  });

  const balance1_final = await connection.getBalance(player1.publicKey);
  const balance2_final = await connection.getBalance(player2.publicKey);
  console.log("Final player balances after manual_refund:", {
    player1: balance1_final / anchor.web3.LAMPORTS_PER_SOL,
    player2: balance2_final / anchor.web3.LAMPORTS_PER_SOL,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


