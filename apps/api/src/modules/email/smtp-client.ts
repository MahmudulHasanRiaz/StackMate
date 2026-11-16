/**
 * Minimal SMTP client for Cloudflare Workers (Auth + Email batch, ADR-0008).
 *
 * Workers cannot open raw SMTP sockets with fetch. They CAN open TCP
 * sockets via `cloudflare:sockets` (verified from the official docs,
 * developers.cloudflare.com/workers/runtime-apis/tcp-sockets/, updated
 * 2026-10-13): `connect({ hostname, port }, { secureTransport })` with
 * `"off" | "on" | "starttls"`, and `socket.startTls()` upgrades a
 * STARTTLS socket (the socket must be created with `secureTransport:
 * "starttls"`). Sockets must be created INSIDE a handler, never in
 * global scope. **Port 25 is BLOCKED by Cloudflare** — submission
 * ports 465 (implicit TLS), 587 (STARTTLS), 2465, 2525, 2587 only.
 *
 * This client speaks the real protocol (EHLO → STARTTLS → AUTH LOGIN →
 * MAIL FROM → RCPT TO → DATA → QUIT) over a minimal socket interface
 * that matches `cloudflare:sockets`. The `connect` implementation is
 * injected: production passes the real `connect` (dynamically imported
 * in the email service — never a static top-level import, because
 * vitest runs in Node where `cloudflare:sockets` does not resolve);
 * tests pass a mocked socket. No fake success: every failure throws an
 * `SmtpError` whose message never contains credentials (only the SMTP
 * reply code + a generic description — never what we sent).
 */
export type SmtpTlsMode = "starttls" | "ssl" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  tlsMode: SmtpTlsMode;
}

export interface SmtpMessage {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Minimal subset of the `cloudflare:sockets` Socket shape we use. */
export interface SmtpSocketLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
  startTls?(): SmtpSocketLike;
}

export type SmtpConnectFn = (
  address: { hostname: string; port: number },
  options?: { secureTransport?: "off" | "on" | "starttls" }
) => SmtpSocketLike;

export class SmtpError extends Error {
  readonly replyCode: number | null;
  constructor(message: string, replyCode: number | null = null) {
    super(message);
    this.name = "SmtpError";
    this.replyCode = replyCode;
  }
}

const READ_TIMEOUT_MS = 10_000;
const CRLF = "\r\n";

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** Read SMTP reply lines until a line whose 4th char is a space (end of a multi-line reply). */
class SmtpLineReader {
  private buffer = "";
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();

  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }

  async readReply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      // `250-...` continues, `250 ...` ends the reply.
      if (line.length < 4 || line[3] !== "-") break;
    }
    const last = lines[lines.length - 1]!;
    const code = Number(last.slice(0, 3));
    if (!Number.isInteger(code)) {
      throw new SmtpError("SMTP server returned an unreadable reply.", null);
    }
    return { code, text: lines.join("\n") };
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx >= 0) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, "");
        this.buffer = this.buffer.slice(idx + 1);
        return line;
      }
      const chunk = await this.readChunk();
      if (chunk === null) {
        if (this.buffer.length > 0) {
          const line = this.buffer.replace(/\r$/, "");
          this.buffer = "";
          return line;
        }
        throw new SmtpError("SMTP connection closed while waiting for a reply.", null);
      }
      this.buffer += this.decoder.decode(chunk, { stream: true });
    }
  }

  private async readChunk(): Promise<Uint8Array | null> {
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), READ_TIMEOUT_MS)
    );
    const result = await Promise.race([
      this.reader.read().then((r) => (r.done ? null : r.value)),
      timeout.then(() => {
        throw new SmtpError("SMTP server did not reply in time.", null);
      }),
    ]);
    return result as Uint8Array | null;
  }

  release(): void {
    try {
      this.reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function buildMimeMessage(message: SmtpMessage): string {
  // SMTP DATA is CRLF-delimited: normalize any bare LF in the body
  // first, otherwise dot-stuffing (which splits on CRLF) misses a
  // line that starts with a dot after a bare LF.
  const text = message.text.replace(/\r\n/g, "\n").replace(/\n/g, CRLF);
  const html = message.html?.replace(/\r\n/g, "\n").replace(/\n/g, CRLF);
  const from = message.fromName
    ? `${message.fromName} <${message.from}>`
    : message.from;
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    "MIME-Version: 1.0",
  ];
  if (!html) {
    return [
      ...headers,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      text,
    ].join(CRLF);
  }
  const boundary = `stackmate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    `--${boundary}--`,
    "",
  ].join(CRLF);
}

/** Dot-stuff lines that start with a dot (RFC 5321 §4.5.2). */
function dotStuff(data: string): string {
  return data
    .split(CRLF)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join(CRLF);
}

/**
 * Send one message over SMTP. Throws SmtpError on any protocol failure;
 * returns on success (after QUIT, best-effort). The socket is always
 * closed, even on failure.
 */
export async function sendMailViaSmtp(
  config: SmtpConfig,
  message: SmtpMessage,
  connectImpl: SmtpConnectFn
): Promise<{ ok: true }> {
  if (!config.host || !config.host.trim()) {
    throw new SmtpError("SMTP host is not configured.", null);
  }
  if (config.port === 25) {
    throw new SmtpError(
      "Port 25 is blocked by Cloudflare Workers. Use the submission port (465 for implicit TLS, 587 for STARTTLS).",
      null
    );
  }
  if (config.port < 1 || config.port > 65535) {
    throw new SmtpError("SMTP port is out of range.", null);
  }

  const secureTransport =
    config.tlsMode === "ssl" ? "on" : config.tlsMode === "starttls" ? "starttls" : "off";
  let socket = connectImpl(
    { hostname: config.host.trim(), port: config.port },
    { secureTransport }
  );
  let reader = new SmtpLineReader(socket.readable);
  let writer = socket.writable.getWriter();
  const encoder = new TextEncoder();

  const sendCommand = async (command: string): Promise<void> => {
    await writer.write(encoder.encode(`${command}${CRLF}`));
  };
  const expect = async (command: string | null, codes: number[]): Promise<{ code: number; text: string }> => {
    if (command !== null) await sendCommand(command);
    const reply = await reader.readReply();
    if (!codes.includes(reply.code)) {
      throw new SmtpError(
        `SMTP server rejected the request (reply ${reply.code}).`,
        reply.code
      );
    }
    return reply;
  };

  try {
    await expect(null, [220]);

    const ehlo = await expect("EHLO stackmate", [250]);
    if (config.tlsMode === "starttls") {
      if (!/STARTTLS/i.test(ehlo.text)) {
        throw new SmtpError("SMTP server does not advertise STARTTLS.", null);
      }
      await expect("STARTTLS", [220]);
      if (typeof socket.startTls !== "function") {
        throw new SmtpError("SMTP socket does not support STARTTLS upgrade.", null);
      }
      // startTls() closes the original socket and returns a NEW one —
      // readers and writers must be recreated from it (Cloudflare docs).
      socket = socket.startTls();
      reader.release();
      try {
        writer.releaseLock();
      } catch {
        /* already released */
      }
      reader = new SmtpLineReader(socket.readable);
      writer = socket.writable.getWriter();
      await expect("EHLO stackmate", [250]);
    }

    if (config.username) {
      await expect("AUTH LOGIN", [334]);
      // The AUTH exchange never appears in errors: only reply codes do.
      await expect(base64(config.username), [334]);
      await expect(base64(config.password), [235]);
    }

    await expect(`MAIL FROM:<${message.from}>`, [250]);
    await expect(`RCPT TO:<${message.to}>`, [250]);
    await expect("DATA", [354]);
    const data = `${dotStuff(buildMimeMessage(message))}${CRLF}.${CRLF}`;
    await writer.write(encoder.encode(data));
    const dataReply = await reader.readReply();
    if (dataReply.code !== 250) {
      throw new SmtpError(`SMTP server rejected the message (reply ${dataReply.code}).`, dataReply.code);
    }
    try {
      await expect("QUIT", [221]);
    } catch {
      /* QUIT is best-effort — the message was accepted. */
    }
    return { ok: true };
  } finally {
    try {
      writer.releaseLock();
    } catch {
      /* already released */
    }
    reader.release();
    await socket.close().catch(() => {});
  }
}
