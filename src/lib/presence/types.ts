import type { LastSeen, Row } from "../validate-list";

export type Channel = "whatsapp" | "telegram";

export type Status = "starting" | "qr" | "ready" | "failed" | "closed";

export type Job = {
  rows: Row[];
  total: number;
  /** Rows that needed a lookup, so progress means something. */
  lookups: number;
  done: number;
  running: boolean;
  stoppedReason: string | null;
};

export type Session = {
  id: string;
  channel: Channel;
  status: Status;
  /** Raw QR payload. The route renders it to a PNG; it rotates, so it is re-read. */
  qr: string | null;
  error: string | null;
  /** The linked account's own identity, once known — proof of what was linked. */
  me: string | null;
  /** Driver-owned client handle. */
  handle: unknown;
  /** Driver-owned scratch state (Telegram tracks contacts it must delete). */
  scratch: unknown;
  /** Saved credentials so a provider resumes without a fresh QR. */
  restoreData?: string | null;
  /** Called when the driver learns something worth persisting. */
  persist?: (patch: { identifier?: string | null; sessionData?: string | null }) => Promise<void>;
  /** Operator-owned: exempt from the idle reaper. */
  pinned?: boolean;
  /** When linking began, so an unscanned QR can be given up on. */
  linkingSince?: number;
  /** When the session was opened, so one that hangs in "starting" can be retried. */
  startedAt?: number;
  job: Job | null;
  lastTouched: number;
};

/**
 * What a channel must provide to be checkable. The job runner in store.ts is
 * written entirely against this, which is why adding Telegram did not mean
 * writing a second runner with its own subtly different safety rules.
 */
/** What one lookup can say about one number. */
export type LookupAnswer = {
  found: boolean;
  /** Activity, when the channel exposes it at all. */
  lastSeen?: LastSeen;
};

export type Driver = {
  channel: Channel;
  label: string;
  /** Numbers per lookup call. WhatsApp asks one at a time; Telegram imports batches. */
  batchSize: number;
  /** Pause between calls, before jitter. */
  delayMs: number;
  /** Refuse runs longer than this — these are per-account budgets, not UI limits. */
  maxLookups: number;
  /** Wording for a positive and a negative, because a negative means different
   *  things on different services. */
  foundReason: string;
  notFoundReason: string;
  open(session: Session): Promise<void>;
  close(session: Session, logout: boolean): Promise<void>;
  /** e164 -> answer. Throwing is fine; the runner records UNKNOWN, never "no". */
  lookup(session: Session, e164s: string[]): Promise<Record<string, LookupAnswer>>;
  /** Cleanup after a run (Telegram deletes the contacts it had to import). */
  finish?(session: Session): Promise<void>;
  /** Recognize an error that means "stop now", e.g. a FLOOD_WAIT of hours. */
  fatal?(err: unknown): string | null;
  /**
   * Seconds the service asked us to wait, if it said so.
   *
   * With fixed pacing removed this is the real rate limiter: the provider is
   * parked for exactly as long as it asked for, then resumes.
   */
  cooldown?(err: unknown): number | null;
  /**
   * Recognize an error that means the transport died but the credentials are
   * fine — a dropped socket, a replaced connection. The pool restarts these
   * instead of taking the account out of service.
   */
  recoverable?(err: unknown): boolean;
};
