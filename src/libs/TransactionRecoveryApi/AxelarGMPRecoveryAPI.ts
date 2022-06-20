import { loadChains } from "../../chains";
import { ChainInfo } from "../../chains/types";
import {
  AxelarRecoveryAPIConfig,
  EvmChain,
  EVMClientConfig,
  EvmWalletDetails,
  AddGasOptions,
  GasToken,
  GatewayEventLog,
  TxResult,
} from "../types";
import { AxelarRecoveryApi, GMPStatus, rpcMap } from "./AxelarRecoveryApi";
import EVMClient from "./client/EVMClient";
import { broadcastCosmosTxBytes } from "./client/helpers/cosmos";
import AxelarGMPRecoveryProcessor from "./processors";
import IAxelarExecutable from "../abi/IAxelarExecutable";
import { BigNumber, ContractFunction, ethers } from "ethers";
import IAxelarGasService from "../abi/IAxelarGasService.json";
import AxelarGateway from "../abi/axelarGatewayAbi.json";
import { Fragment, Interface } from "ethers/lib/utils";
import { DEFAULT_ESTIMATED_GAS, GAS_RECEIVER, NATIVE_GAS_TOKEN_SYMBOL } from "./constants/contract";
import { AxelarQueryAPI } from "../AxelarQueryAPI";

export class AxelarGMPRecoveryAPI extends AxelarRecoveryApi {
  private processor: AxelarGMPRecoveryProcessor;
  private axelarQueryApi: AxelarQueryAPI;
  public constructor(config: AxelarRecoveryAPIConfig) {
    super(config);
    this.processor = new AxelarGMPRecoveryProcessor(this);
    this.axelarQueryApi = new AxelarQueryAPI({
      environment: config.environment,
    });
  }

  public async saveGMP(
    sourceTransactionHash: string,
    transactionHash: string,
    relayerAddress: string,
    error?: any
  ) {
    return await this.execPost(super.getAxelarCachingServiceUrl, "", {
      method: "saveGMP",
      sourceTransactionHash,
      transactionHash,
      relayerAddress,
      error,
    });
  }

  public async confirmGatewayTx(params: { txHash: string; chain: string }) {
    const chain: ChainInfo = loadChains({
      environment: this.environment,
    }).find((chain) => chain.chainInfo.chainName.toLowerCase() === params.chain.toLowerCase())
      ?.chainInfo as ChainInfo;
    if (!chain) throw new Error("cannot find chain" + params.chain);

    const txBytes = await this.execRecoveryUrlFetch("/confirm_gateway_tx", {
      ...params,
      module: chain.module,
      chain: chain.chainIdentifier[this.environment],
    });

    const tx = await broadcastCosmosTxBytes(txBytes, this.axelarRpcUrl);

    return tx;
  }

  public async manualRelayToDestChain(params: {
    txHash: string;
    src: EvmChain;
    dest: EvmChain;
    debug?: boolean;
  }): Promise<"triggered relay" | "approved but not executed" | "already executed" | unknown> {
    return await this.processor.process(params);
  }

  public async isExecuted(txHash: string): Promise<boolean> {
    const txStatus = await this.queryTransactionStatus(txHash);
    return txStatus.status === GMPStatus.EXECUTED;
  }

  public async calculateWantedGasFee(
    txHash: string,
    sourceChain: EvmChain,
    destinationChain: EvmChain,
    gasTokenSymbol: GasToken | string,
    estimatedGas = DEFAULT_ESTIMATED_GAS
  ): Promise<string> {
    const totalGasFee = await this.axelarQueryApi.estimateGasFee(
      sourceChain,
      destinationChain,
      gasTokenSymbol,
      estimatedGas
    );
    const provider = new ethers.providers.JsonRpcProvider(rpcMap[sourceChain]);
    const receipt = await provider.getTransactionReceipt(txHash);
    const paidGasFee = this.getNativeGasAmountFromTxReceipt(receipt) || "0";
    const topupGasAmount = ethers.BigNumber.from(totalGasFee).sub(paidGasFee);
    return topupGasAmount.gt(0) ? topupGasAmount.toString() : "0";
  }

  public async addNativeGas(
    chain: EvmChain,
    txHash: string,
    logIndex: number,
    options?: AddGasOptions
  ): Promise<TxResult> {
    const evmWalletDetails = options?.evmWalletDetails || { useWindowEthereum: true };
    const signer = this.getSigner(chain, evmWalletDetails);
    const signerAddress = await signer.getAddress();
    const gasReceiverAddress = GAS_RECEIVER[this.environment][chain];
    const nativeGasTokenSymbol = NATIVE_GAS_TOKEN_SYMBOL[chain];
    const receipt = await signer.provider.getTransactionReceipt(txHash);
    const destinationChain = this.getDestinationChainFromTxReceipt(receipt);
    const paidGasFee = this.getNativeGasAmountFromTxReceipt(receipt);

    // 1. Check if given txHash is valid
    if (!destinationChain || !paidGasFee) {
      return {
        success: false,
        error: "Invalid GMP transaction",
      };
    }

    // 2. Check if the transaction status is already executed or not.
    const _isExecuted = await this.isExecuted(txHash);
    if (_isExecuted) {
      return {
        success: false,
        error: "Already executed",
      };
    }

    const wantedGasFee = await this.calculateWantedGasFee(
      txHash,
      chain,
      destinationChain,
      nativeGasTokenSymbol,
      options?.estimatedGasUsed
    );

    // 3. Check if gas fee is not already sufficiently paid.
    if (wantedGasFee === "0") {
      return {
        success: false,
        error: "Already paid sufficient gas fee",
      };
    }

    const gasFeeAmount = options?.amount || wantedGasFee;
    const refundAddress = options?.refundAddress || signerAddress;

    const contract = new ethers.Contract(gasReceiverAddress, IAxelarGasService, signer);
    const tx = await contract.addNativeGas(txHash, logIndex, refundAddress, {
      value: gasFeeAmount,
    });

    return {
      success: true,
      transaction: tx,
    };
  }

  public async executeManually(
    data: {
      call: any;
      approved: any;
    },
    cb: any
  ): Promise<void> {
    try {
      const { call, approved } = data;
      const { event } = call;
      const { destinationChain, destinationContractAddress, payload } = call?.returnValues;
      const { commandId, sourceChain, sourceAddress, symbol, amount } = approved?.returnValues;

      const evmClientConfig: EVMClientConfig = {
        rpcUrl: rpcMap[destinationChain as EvmChain],
        evmWalletDetails: { useWindowEthereum: true },
      };

      const evmClient = new EVMClient(evmClientConfig);
      const signer = evmClient.getSigner();
      const address: string = await signer.getAddress();

      const contract = new ethers.Contract(
        destinationContractAddress,
        IAxelarExecutable.abi,
        signer
      );

      const methods: { [key: string]: ContractFunction } = {
        ContractCall: () => contract.execute(commandId, sourceChain, sourceAddress, payload),
        ContractCallWithToken: () =>
          contract.executeWithToken(
            commandId,
            sourceChain,
            sourceAddress,
            payload,
            symbol,
            BigNumber.from(amount).toString()
          ),
      };

      if (methods[event]) {
        let tx;
        try {
          tx = await methods[event]();
          if (tx.hash) {
            cb({
              status: "pending",
              message: "Wait for confirmation",
              txHash: tx.hash,
            });
          }
          await tx.wait(1);
          if (tx.hash) {
            cb({
              status: "success",
              message: "Execute successful",
              txHash: tx.hash,
            });
            await this.saveGMP(call?.transactionHash, tx.hash, address);
          }
        } catch (error: any) {
          await this.saveGMP(call?.transactionHash, tx?.hash, address, error);
          cb({
            status: "failed",
            message: error?.reason || error?.data?.message || error?.message,
            txHash: tx?.hash,
          });
        }
      } else {
        console.warn(`method ${event} does not exist!`);
      }
    } catch (error: any) {
      cb({
        status: "failed",
        message: error?.reason || error?.data?.message || error?.message,
        txHash: "",
      });
    }
  }

  public getDestinationChainFromTxReceipt(
    receipt: ethers.providers.TransactionReceipt
  ): Nullable<EvmChain> {
    const signatureContractCallWithToken = ethers.utils.id(
      "ContractCallWithToken(address,string,string,bytes32,bytes,string,uint256)"
    );
    const signatureContractCall = ethers.utils.id(
      "ContractCall(address,string,string,bytes32,bytes)"
    );

    const event = this.findContractEvent(
      receipt,
      [signatureContractCall, signatureContractCallWithToken],
      new Interface(AxelarGateway)
    );
    return event?.eventLog.args[1];
  }

  public getNativeGasAmountFromTxReceipt(
    receipt: ethers.providers.TransactionReceipt
  ): Nullable<string> {
    const signatureGasPaidContractCallWithToken = ethers.utils.id(
      "NativeGasPaidForContractCallWithToken(address,string,string,bytes32,string,uint256,uint256,address)"
    );
    const signatureGasPaidContractCall = ethers.utils.id(
      "NativeGasPaidForContractCall(address,string,string,bytes,address)"
    );

    const event = this.findContractEvent(
      receipt,
      [signatureGasPaidContractCall, signatureGasPaidContractCallWithToken],
      new Interface(IAxelarGasService)
    );
    console.log(signatureGasPaidContractCallWithToken);
    return event?.eventLog.args.slice(-2)[0].toString();
  }

  private getSigner(
    chain: EvmChain,
    evmWalletDetails: EvmWalletDetails = { useWindowEthereum: true }
  ) {
    const evmClientConfig: EVMClientConfig = {
      rpcUrl: rpcMap[chain],
      evmWalletDetails,
    };
    const evmClient = new EVMClient(evmClientConfig);
    return evmClient.getSigner();
  }

  private findContractEvent(
    receipt: ethers.providers.TransactionReceipt,
    eventSignatures: string[],
    abiInterface: Interface
  ): Nullable<GatewayEventLog> {
    for (const log of receipt.logs) {
      const eventIndex = eventSignatures.indexOf(log.topics[0]);
      if (eventIndex > -1) {
        const eventLog = abiInterface.parseLog(log);
        return {
          signature: eventSignatures[eventIndex],
          eventLog,
        };
      }
    }
  }
}
