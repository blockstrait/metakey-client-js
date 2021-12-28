import { Wamp } from '@blockstrait/metakey-core';

type MessageReceivedHandler = (message: Wamp.Message) => void;
type onTransportDisconnectedCallback = (reason: string) => void;

class TransportError extends Error {
  public errorCode: string;

  constructor(errorCode: string, errorMessage?: string) {
    super(errorMessage);

    this.errorCode = errorCode;
  }
}

abstract class Transport {
  protected messageFactory: Wamp.MessageFactory;
  protected messageReceivedHandler?: MessageReceivedHandler;
  protected onTransportDisconnected?: onTransportDisconnectedCallback;

  constructor() {
    this.messageFactory = new Wamp.MessageFactory();
  }

  attachMessageReceivedHandler(messageReceivedHandler: MessageReceivedHandler) {
    this.messageReceivedHandler = messageReceivedHandler;
  }

  attachOnDisconnectedHandler(
    onTransportDisconnected: onTransportDisconnectedCallback
  ) {
    this.onTransportDisconnected = onTransportDisconnected;
  }

  abstract initialize(): void;

  abstract destroy(): void;

  abstract connect(): Promise<number>;

  abstract sendMessage(message: Wamp.Message): void;
}

export { Transport, TransportError };
