export type OutgoingMail = { to: string; subject: string; body: string };

/** Anything that can deliver an email. Graph in production, fakes in tests. */
export interface MailTransport {
  send(mail: OutgoingMail): Promise<void>;
}
