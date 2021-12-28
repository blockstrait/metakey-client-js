import { Wamp } from '@blockstrait/metakey-core';

import { Transport } from './transports';

type SessionState = 'closed' | 'establishing' | 'established' | 'shutting-down';

interface Session {
  state: SessionState;
  id?: number;
  resolveCallback?: (data: any) => void;
  rejectCallback?: (data: any) => void;
}

type MessageTypes = Wamp.HelloMessage['type'] | Wamp.WelcomeMessage['type'];

type HandlerFunction = (message: Wamp.Message) => void;

type HandlerMapping = { [K in MessageTypes]: HandlerFunction };

interface CallParams {
  procedureUri: string;
  args?: string[];
  kwArgs?: object;
}

interface CallResult {
  args?: string[];
  kwArgs?: object;
}

interface WampClientParams {
  requestTimeout?: number;
  transport: Transport;
}

function randomid(): number {
  return Math.floor(Math.random() * Math.pow(2, 53));
}

class WampClientError extends Error {
  public errorCode: string;

  constructor(errorCode: string, errorMessage?: string) {
    super(errorMessage);

    this.errorCode = errorCode;
  }
}

class WampClient {
  private currentSession: Session;
  private transport: Transport;
  private transportConnected: boolean;
  private messageHandlers: HandlerMapping;
  private currentRequestId: number | null;
  private pendingRequestTimer: ReturnType<typeof setTimeout> | null;
  private requestTimeout: number;

  constructor(params: WampClientParams) {
    const { transport, requestTimeout } = params;

    this.transport = transport;

    this.messageHandlers = {};

    this.messageHandlers[Wamp.WelcomeMessage.type] =
      this.handleWelcomeMessage.bind(this);
    this.messageHandlers[Wamp.ResultMessage.type] =
      this.handleResultMessage.bind(this);
    this.messageHandlers[Wamp.GoodbyeMessage.type] =
      this.handleGoodbyeMessage.bind(this);
    this.messageHandlers[Wamp.AbortMessage.type] =
      this.handleAbortMessage.bind(this);
    this.messageHandlers[Wamp.CallErrorMessage.type] =
      this.handleCallErrorMessage.bind(this);

    this.currentSession = {
      state: 'closed',
    };

    this.currentRequestId = null;

    this.requestTimeout = requestTimeout ? requestTimeout : 30000;

    this.pendingRequestTimer = null;

    this.transportConnected = false;
  }

  initialize() {
    this.transport.attachMessageReceivedHandler(
      this.onMessageReceived.bind(this)
    );

    this.transport.attachOnDisconnectedHandler(
      this.onTransportDisconnected.bind(this)
    );

    this.transport.initialize();
  }

  private requestTimeoutFn() {
    this.pendingRequestTimer = null;

    this.rejectFromHandler('REQUEST_TIMEOUT', 'Request timeout');
  }

  private sessionClosed() {
    this.currentSession.id = undefined;
    this.currentSession.state = 'closed';
  }

  private sendRequest(message: Wamp.Message): Promise<Wamp.Message> {
    return new Promise((resolve, reject) => {
      this.currentSession.resolveCallback = resolve;
      this.currentSession.rejectCallback = reject;

      this.pendingRequestTimer = setTimeout(
        this.requestTimeoutFn.bind(this),
        this.requestTimeout
      );

      this.transport.sendMessage(message);
    });
  }

  async destroy() {
    const goodbyeMessage = new Wamp.GoodbyeMessage({
      reason: 'wamp.close.system_shutdown',
      errorMessage: 'Shutting down client',
    });

    this.currentSession.state = 'shutting-down';

    try {
      await this.sendRequest(goodbyeMessage);
    } finally {
      this.currentSession.state = 'closed';

      this.transport.destroy();
    }
  }

  private onTransportDisconnected() {
    this.transportConnected = false;
    this.currentSession.state = 'closed';
  }

  private async connect(): Promise<number> {
    const isSessionClosed = this.currentSession.state === 'closed';

    if (!isSessionClosed) {
      throw new WampClientError(
        'SESSION_NOT_CLOSED',
        'The current session is active'
      );
    }

    if (!this.transportConnected) {
      await this.transport.connect();

      this.transportConnected = true;
    }

    const helloMessage = new Wamp.HelloMessage({
      realm: 'METAKEY',
      roles: ['caller'],
    });

    this.currentSession.state = 'establishing';

    const welcomeMessage = (await this.sendRequest(
      helloMessage
    )) as Wamp.WelcomeMessage;

    this.currentSession.id = welcomeMessage.session;
    this.currentSession.state = 'established';

    return welcomeMessage.session;
  }

  async call(params: CallParams): Promise<CallResult> {
    const isSessionEstablished = this.currentSession.state === 'established';
    const isSessionClosed = this.currentSession.state === 'closed';

    const isSessionInCorrectState = isSessionEstablished || isSessionClosed;

    if (!isSessionInCorrectState) {
      throw new WampClientError('INVALID_STATE', 'Invalid state');
    }

    if (!isSessionEstablished) {
      await this.connect();
    }

    const requestId = randomid();

    const callMessage = new Wamp.CallMessage({
      requestId,
      procedureUri: params.procedureUri,
      args: params.args,
      kwArgs: params.kwArgs,
    });

    this.currentRequestId = requestId;

    let resultMessage: Wamp.ResultMessage;

    try {
      resultMessage = (await this.sendRequest(
        callMessage
      )) as Wamp.ResultMessage;
    } finally {
      this.currentRequestId = null;
    }

    return {
      args: resultMessage.args,
      kwArgs: resultMessage.kwArgs,
    };
  }

  private clearRequestTimer() {
    if (this.pendingRequestTimer !== null) {
      clearTimeout(this.pendingRequestTimer);
    }

    this.pendingRequestTimer = null;
  }

  private resolveFromHandler(result?: any) {
    const resolveFn = this.currentSession.resolveCallback;

    if (resolveFn === undefined) {
      throw new WampClientError(
        'UNEXPECTED_ERROR',
        'Resolve function cannot be undefined'
      );
    }

    resolveFn(result);
  }

  private rejectFromHandler(errorCode: string, errorMessage?: string) {
    const rejectFn = this.currentSession.rejectCallback;

    if (rejectFn === undefined) {
      throw new WampClientError(
        'UNEXPECTED_ERROR',
        'Reject function cannot be undefined'
      );
    }

    rejectFn(new WampClientError(errorCode, errorMessage));
  }

  private handleWelcomeMessage(message: Wamp.Message) {
    const isInCorrectState = this.currentSession.state === 'establishing';

    if (!isInCorrectState) {
      const abortMessage = new Wamp.AbortMessage({
        reason: 'wamp.error.protocol_violation',
        errorMessage: 'Received WELCOME message after session was established.',
      });

      this.transport.sendMessage(abortMessage);

      return this.rejectFromHandler('PROTOCOL_VIOLATION', 'Incorrect state');
    }

    this.clearRequestTimer();

    this.resolveFromHandler(message);
  }

  private handleResultMessage(message: Wamp.Message) {
    const resultMessage = message as Wamp.ResultMessage;

    const isInCorrectState = this.currentSession.state === 'established';

    if (!isInCorrectState) {
      const errorMessage = 'A session must be established';

      const abortMessage = new Wamp.AbortMessage({
        reason: 'wamp.error.protocol_violation',
        errorMessage,
      });

      this.transport.sendMessage(abortMessage);

      return this.rejectFromHandler('PROTOCOL_VIOLATION', errorMessage);
    }

    const isExpectingResultMessage =
      this.currentRequestId !== null &&
      this.currentRequestId === resultMessage.requestId;

    if (!isExpectingResultMessage) {
      const errorMessage = 'Unexpected RESULT message';

      const abortMessage = new Wamp.AbortMessage({
        reason: 'wamp.error.protocol_violation',
        errorMessage,
      });

      this.transport.sendMessage(abortMessage);

      return this.rejectFromHandler('PROTOCOL_VIOLATION', errorMessage);
    }

    this.clearRequestTimer();

    this.resolveFromHandler(message);
  }

  private handleGoodbyeMessage(message: Wamp.Message) {
    const goodbyeMessage = message as Wamp.GoodbyeMessage;

    const isSessionShuttingDown = this.currentSession.state === 'shutting-down';
    const isSessionEstablished = this.currentSession.state === 'established';

    const isInCorrectState = isSessionShuttingDown || isSessionEstablished;

    if (!isInCorrectState) {
      const abortMessage = new Wamp.AbortMessage({
        reason: 'wamp.error.protocol_violation',
        errorMessage: 'Unexpected GOODBYE message.',
      });

      this.transport.sendMessage(abortMessage);

      return this.rejectFromHandler('PROTOCOL_VIOLATION', 'Incorrect state');
    }

    if (isSessionEstablished) {
      const responseMessage = new Wamp.GoodbyeMessage({
        reason: 'wamp.close.system_shutdown',
        errorMessage: 'Shutting down client',
      });

      this.transport.sendMessage(responseMessage);
    }

    if (isSessionShuttingDown) {
      this.clearRequestTimer();

      this.sessionClosed();

      this.resolveFromHandler(goodbyeMessage.reason);
    }
  }

  private handleAbortMessage(message: Wamp.Message) {
    const abortMessage = message as Wamp.AbortMessage;

    const isSessionEstablished = this.currentSession.state === 'established';
    const isSessionEstablishing = this.currentSession.state === 'establishing';
    const isRequestPending = this.currentRequestId !== null;

    if (isSessionEstablished) {
      const responseMessage = new Wamp.GoodbyeMessage({
        reason: 'wamp.close.system_shutdown',
        errorMessage: 'Shutting down client',
      });

      this.transport.sendMessage(responseMessage);
    }

    if (isRequestPending || isSessionEstablishing) {
      this.sessionClosed();

      return this.rejectFromHandler(
        'SESSION_ABORTED',
        `Peer has aborted the session with reason: ${abortMessage.reason}`
      );
    }
  }

  private handleCallErrorMessage(message: Wamp.Message) {
    const callErrorMessage = message as Wamp.CallErrorMessage;

    const isSessionEstablished = this.currentSession.state === 'established';

    const isInCorrectState = isSessionEstablished;

    if (!isInCorrectState) {
      const abortMessage = new Wamp.AbortMessage({
        reason: 'wamp.error.protocol_violation',
        errorMessage: 'Unexpected CALL ERROR message.',
      });

      this.transport.sendMessage(abortMessage);

      return this.rejectFromHandler('PROTOCOL_VIOLATION', 'Incorrect state');
    }

    const isRequestPending = this.currentRequestId !== null;

    if (isRequestPending) {
      return this.rejectFromHandler(
        'CALL_ERROR',
        `Call error returned: ${JSON.stringify(
          callErrorMessage.args
        )}, ${JSON.stringify(callErrorMessage.kwArgs)}`
      );
    }
  }

  private onMessageReceived(message: Wamp.Message) {
    const messageHandler = this.messageHandlers[message.type];

    if (messageHandler !== undefined) {
      messageHandler(message);
    }
  }
}

export { WampClient, WampClientError, WampClientParams, CallResult };
