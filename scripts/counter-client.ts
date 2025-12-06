import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { Counter } from "../target/types/counter"

const PROGRAM_ID = new PublicKey("GKnpQhwv2os3k6naVpb4GWkdmohFzoGgv3aCEkweRH6q")

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.counter as Program<Counter>;

  const [counterPDA, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("counter"), provider.publicKey!.toBuffer()],
    PROGRAM_ID,
  );

  console.log("Counter PDA:", counterPDA.toBase58(), bump);


  // // 1) initialize
  // await program.methods
  //   .initialize()
  //   .accounts({
  //     user: provider.publicKey!,
  //   })
  //   .rpc();

  // increment
  for (let i = 0; i < 3; i++) {
    await program.methods
      .increment()
      .accounts({
        user: provider.publicKey!,
      })
      .rpc();
  }

  // decrement
  await program.methods
    .decrement()
    .accounts({
      user: provider.publicKey!,
    })
    .rpc();

  const account = await program.account.counter.fetch(counterPDA);
  console.log("Current counter value:", account.count.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
