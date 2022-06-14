import { defaultAbiCoder, keccak256, getCreate2Address, toUtf8Bytes } from "ethers/lib/utils";
import DepositReceiver from "./abi/DepositReceiver.json";

export const generateOfflineDepositAddress = (
  depositServiceAddress: string,
  bytes32salt: string,
  destinationChain: string,
  destinationAddress: string,
  tokenSymbol: string
) => {
  return getCreate2Address(
    depositServiceAddress,
    keccak256(
      defaultAbiCoder.encode(
        ["bytes32", "bytes32", "string", "string", "string"],
        [
          keccak256(toUtf8Bytes("deposit-send-token")),
          bytes32salt,
          destinationChain,
          destinationAddress,
          tokenSymbol,
        ]
      )
    ),
    keccak256(`0x${DepositReceiver.bytecode}`)
  );
};