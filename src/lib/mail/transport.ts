export type OutgoingMail = { to: string; subject: string; body: string };

/** Thread identifiers of a delivered message, used to match vendor replies to the project. */
export type SendReceipt = { conversationId?: string; internetMessageId?: string };

/** Anything that can deliver an email. Graph in production, fakes in tests. */
export interface MailTransport {
  send(mail: OutgoingMail): Promise<SendReceipt | void>;
}

/**
 * kind "permanent": this message can never succeed (bad recipient) -> mark Failed now.
 * kind "run": the service or our credentials are the problem (auth, throttling, outage,
 * timeout) -> stop the run, leave every row Queued, charge no attempts.
 * Any other thrown Error is treated as a per-message failure with up to MAX_ATTEMPTS.
 */
export class MailError extends Error {
  kind: "permanent" | "run";
  constructor(message: string, kind: "permanent" | "run") {
    super(message);
    this.kind = kind;
  }
}
