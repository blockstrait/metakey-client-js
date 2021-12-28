import {
  Wamp,
  BrowserExtensionTransport as TransportMessages,
} from '@blockstrait/metakey-core';

import { Transport, TransportError } from './transport';

type ConnectionState = 'closed' | 'establishing' | 'established';

interface Connection {
  state: ConnectionState;
  id?: number;
  resolveCallback?: (data: any) => void;
  rejectCallback?: (data: any) => void;
}

interface BrowserExtensionTransportParams {
  requestTimeout?: number;
}

const METAKEY_CLIENT_DESTINATION = 'metakey-client';
const METAKEY_CONTENT_SCRIPT_DESTINATION = 'metakey-contentscript';

class BrowserExtensionTransport extends Transport {
  private targetWindow: Window;
  private targetOrigin: string;
  private transportMessageFactory: TransportMessages.MessageFactory;
  private connection: Connection;
  private pendingRequestTimer: ReturnType<typeof setTimeout> | null;
  private requestTimeout: number;

  constructor(params?: BrowserExtensionTransportParams) {
    super();

    const { requestTimeout } = params || {};

    this.targetWindow = window;

    this.targetOrigin = location.origin;

    this.transportMessageFactory = new TransportMessages.MessageFactory();

    this.connection = {
      state: 'closed',
    };

    this.requestTimeout = requestTimeout ? requestTimeout : 2000;

    this.pendingRequestTimer = null;

    this.onMessageReceived = this.onMessageReceived.bind(this);
  }

  initialize() {
    if (this.attachMessageReceivedHandler === undefined) {
      throw new Error('Message received handler must be attached');
    }

    window.addEventListener('message', this.onMessageReceived, false);
  }

  destroy() {
    window.removeEventListener('message', this.onMessageReceived, false);
  }

  private clearRequestTimer() {
    if (this.pendingRequestTimer !== null) {
      clearTimeout(this.pendingRequestTimer);
    }

    this.pendingRequestTimer = null;
  }

  private handleConnectReplyMessage(
    connectReplyMessage: TransportMessages.ConnectReplyMessage
  ) {
    const rejectCallback = this.connection.rejectCallback;

    const resolveCallback = this.connection.resolveCallback;

    if (rejectCallback === undefined) {
      throw new Error('Corrupted state');
    }

    if (resolveCallback === undefined) {
      throw new Error('Corrupted state');
    }

    try {
      if (connectReplyMessage.status !== 'SUCCESS') {
        return rejectCallback(
          new TransportError(
            'CONNECT_ERROR',
            'Could not connect to browser extension'
          )
        );
      }

      this.connection.state = 'established';
      this.connection.id = connectReplyMessage.id;

      resolveCallback(connectReplyMessage.id);
    } finally {
      this.clearRequestTimer();

      this.connection.resolveCallback = undefined;
      this.connection.rejectCallback = undefined;
    }
  }

  private handleDataMessage(dataMessage: TransportMessages.DataMessage) {
    if (this.messageReceivedHandler === undefined) {
      throw new Error('Message handle must be defined');
    }

    const wampMessageFactory = new Wamp.MessageFactory();

    const message = wampMessageFactory.fromJSON(dataMessage.payload);

    this.messageReceivedHandler(message);
  }

  private handleDisconnectedMessage(
    disconnectedMessage: TransportMessages.DisconnectedMessage
  ) {
    this.connection.state = 'closed';

    if (this.onTransportDisconnected) {
      this.onTransportDisconnected(disconnectedMessage.reason);
    }
  }

  private onMessageReceived(event: MessageEvent) {
    const isEventValid =
      event.origin === this.targetOrigin &&
      event.source === this.targetWindow &&
      typeof event.data === 'object' &&
      typeof event.data.metakeyMessage === 'string' &&
      event.data.metakeyDestination === METAKEY_CLIENT_DESTINATION;

    if (!isEventValid) {
      return;
    }

    const { metakeyMessage: serializedMessage } = event.data;

    try {
      const message = this.transportMessageFactory.fromJSON(serializedMessage);

      switch (message.type) {
        case TransportMessages.ConnectReplyMessage.type:
          this.handleConnectReplyMessage(
            message as TransportMessages.ConnectReplyMessage
          );
          break;

        case TransportMessages.DataMessage.type:
          this.handleDataMessage(message as TransportMessages.DataMessage);
          break;

        case TransportMessages.DisconnectedMessage.type:
          this.handleDisconnectedMessage(
            message as TransportMessages.DisconnectedMessage
          );
          break;

        default:
          throw new Error('Invalid message');
      }
    } catch (error) {
      // Ignore message
    }
  }

  private requestTimeoutFn() {
    this.pendingRequestTimer = null;

    const connection = this.connection;

    if (
      typeof connection !== 'object' ||
      typeof connection.rejectCallback !== 'function'
    ) {
      throw new Error('No connection exists');
    }

    this.connection = {
      state: 'closed',
    };

    connection.rejectCallback(
      new TransportError('REQUEST_TIMEOUT', 'Request timeout')
    );
  }

  async connect(): Promise<number> {
    const canEstablishNewConnection = this.connection.state === 'closed';

    if (!canEstablishNewConnection) {
      throw new TransportError(
        'CONNECTION_EXISTS',
        'Only one connection can be established at a time'
      );
    }

    const connectMessage = new TransportMessages.ConnectMessage();

    return new Promise((resolve, reject) => {
      this.connection.state = 'establishing';
      this.connection.resolveCallback = resolve;
      this.connection.rejectCallback = reject;

      this.pendingRequestTimer = setTimeout(
        this.requestTimeoutFn.bind(this),
        this.requestTimeout
      );

      this.targetWindow.postMessage(
        {
          metakeyDestination: METAKEY_CONTENT_SCRIPT_DESTINATION,
          metakeyMessage: connectMessage.serialize(),
        },
        this.targetOrigin
      );
    });
  }

  sendMessage(message: Wamp.Message) {
    const dataMessage = new TransportMessages.DataMessage({
      payload: message.serialize(),
    });

    this.targetWindow.postMessage(
      {
        metakeyDestination: METAKEY_CONTENT_SCRIPT_DESTINATION,
        metakeyMessage: dataMessage.serialize(),
      },
      this.targetOrigin
    );
  }
}

export { BrowserExtensionTransport, BrowserExtensionTransportParams };
