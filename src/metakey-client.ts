import { Transport, BrowserExtensionTransport } from './transports';

import { WampClient, CallResult } from './wamp-client';

interface MetakeyClientParams {
  transport?: Transport;
}

interface SignMessageParams {
  message: string;
  derivationPath: string;
}

interface GetXpubParams {
  derivationPath: string;
}

interface SignTransactionParams {
  unlockingScriptPushData: object;
  unsignedRawTx: string;
  parentTxs: object[];
  changeOutputIndexes: number[];
}

interface GetCapabilitiesResult {
  capabilities: object;
}

interface SignMessageResult {
  signature: string;
}

interface GetXpubResult {
  xpub: string;
}

interface SignTransactionResult {
  rawTx: string;
}

class MetakeyClientError extends Error {
  public errorCode: string;

  constructor(errorCode: string, errorMessage?: string) {
    super(errorMessage);

    this.errorCode = errorCode;
  }
}

class MetakeyClient {
  private wampClient: WampClient;

  constructor(params?: MetakeyClientParams) {
    let { transport } = params || {};

    if (transport === undefined) {
      transport = new BrowserExtensionTransport();
    }

    this.wampClient = new WampClient({ transport });
  }

  initialize() {
    this.wampClient.initialize();
  }

  async destroy() {
    return this.wampClient.destroy();
  }

  async getCapabilities(): Promise<GetCapabilitiesResult> {
    const result: CallResult = await this.wampClient.call({
      procedureUri: 'metakey.487179e4718d',
    });

    if (typeof result.kwArgs !== 'object') {
      throw new MetakeyClientError('RESULT_ERROR', 'No capabilities returned');
    }

    return {
      capabilities: result.kwArgs,
    };
  }

  async signMessage(params: SignMessageParams): Promise<SignMessageResult> {
    const result: CallResult = await this.wampClient.call({
      procedureUri: 'metakey.0cb27441d280',
      args: [params.message, params.derivationPath],
    });

    if (!Array.isArray(result.args) || result.args.length === 0) {
      throw new MetakeyClientError('RESULT_ERROR', 'No signature returned');
    }

    return {
      signature: result.args[0],
    };
  }

  async getXpub(params: GetXpubParams): Promise<GetXpubResult> {
    const result: CallResult = await this.wampClient.call({
      procedureUri: 'metakey.50fc32d795dc',
      args: [params.derivationPath],
    });

    if (!Array.isArray(result.args) || result.args.length === 0) {
      throw new MetakeyClientError('RESULT_ERROR', 'No xpub returned');
    }

    return {
      xpub: result.args[0],
    };
  }

  async signTransaction(
    params: SignTransactionParams
  ): Promise<SignTransactionResult> {
    const result: CallResult = await this.wampClient.call({
      procedureUri: 'metakey.52238d4af357',
      kwArgs: params,
    });

    if (!Array.isArray(result.args) || result.args.length === 0) {
      throw new MetakeyClientError('RESULT_ERROR', 'No raw Tx returned');
    }

    return {
      rawTx: result.args[0],
    };
  }
}

export {
  MetakeyClient,
  MetakeyClientError,
  MetakeyClientParams,
  GetCapabilitiesResult,
  GetXpubParams,
  GetXpubResult,
  SignMessageParams,
  SignMessageResult,
  SignTransactionParams,
  SignTransactionResult,
};
