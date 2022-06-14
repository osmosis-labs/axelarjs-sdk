import { formatBytes32String } from "ethers/lib/utils";
import { generateOfflineDepositAddress } from "../generateOfflineDepositAddress";

describe("generateOfflineDepositAddress", () => {
  test("It should generate a deterministic deposit address", async () => {
    const from = "0x74Ccd7d9F1F40417C6F7fD1151429a2c44c34e6d";
    const salt = "hello";
    const destinationChain = "avalanche";
    const destinationAddress = "0x74Ccd7d9F1F40417C6F7fD1151429a2c44c34e6d";
    const tokenSymbol = "axlUSDC";
    const depositAddress = generateOfflineDepositAddress(
      from,
      formatBytes32String(salt),
      destinationChain,
      destinationAddress,
      tokenSymbol
    );
    console.log("deposit address", depositAddress);
    expect(depositAddress).toBeTruthy();
  });
});
