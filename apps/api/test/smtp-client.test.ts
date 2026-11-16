/**
 * SMTP client tests (Auth + Email batch, ADR-0008) — in-memory, no DB.
 *
 * The client speaks real SMTP (EHLO → STARTTLS → AUTH LOGIN → MAIL /
 * RCPT / DATA / QUIT) over an injected `connect` function. These tests
 * drive it with a scripted mock socket (a shared reply queue + a
 * recorded command log) and, for the `none` TLS mode, against a real
 * local TCP server (node:net) — so the wire format is verified against
 * a real socket, not just the mock.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client, Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/schema/index.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { saveSmtpSettings } from "../src/modules/auth-config/service.ts";
import {
  sendStackMateEmail,
  type EmailDeps,
} from "../src/modules/email/service.ts";
import {
  sendMailViaSmtp,
  SmtpError,
  type SmtpConnectFn,
  type SmtpMessage,
  type SmtpSocketLike,
} from "../src/modules/email/smtp-client.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);

const MESSAGE: SmtpMessage = {
  from: "noreply@example.com",
  fromName: "StackMate",
  to: "admin@example.com",
  subject: "Test",
  text: "Hello.\n.Second line starts with a dot.",
  html: "<p>Hello.</p>",
};

const CONFIG = {
  host: "smtp.example.com",
  port: 587,
  username: "smtp-user",
  password: "smtp-pass-123",
  tlsMode: "starttls" as const,
};

interface Script {
  replies: string[];
  commands: string[];
}

function makeMockConnect(script: Script, startTlsSocket?: () => SmtpSocketLike): SmtpConnectFn {
  const makeSocket = (): SmtpSocketLike => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    return {
      // highWaterMark 0: pull only when a read is pending, so the
      // stream never prefetches a reply the client has not asked for
      // yet. Without this, the socket's queue would swallow the line
      // that belongs to the post-STARTTLS socket (startTls() returns a
      // NEW socket, and a prefetched line on the old one is lost).
      readable: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const line = script.replies.shift();
            if (line === undefined) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(`${line}\r\n`));
          },
        },
        { highWaterMark: 0 }
      ),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          script.commands.push(decoder.decode(chunk));
        },
      }),
      close: () => Promise.resolve(),
      startTls: startTlsSocket ? () => startTlsSocket() : () => makeSocket(),
    };
  };
  return () => makeSocket();
}

/** The full STARTTLS transcript, in the order the client reads it. */
function starttlsScript(): Script {
  return {
    replies: [
      "220 smtp.example.com ESMTP",
      "250-smtp.example.com Hello",
      "250-STARTTLS",
      "250 AUTH LOGIN",
      "220 Ready to start TLS",
      "250 smtp.example.com Hello",
      "334 VXNlcm5hbWU6",
      "334 UGFzc3dvcmQ6",
      "235 Authentication successful",
      "250 OK",
      "250 OK",
      "354 End data with <CR><LF>.<CR><LF>",
      "250 OK queued",
      "221 Bye",
    ],
    commands: [],
  };
}

describe("SMTP client (mocked socket)", () => {
  it("STARTTLS: speaks the full transcript in order, with the right secureTransport", async () => {
    const script = starttlsScript();
    let secureTransport: string | undefined;
    const connect: SmtpConnectFn = (address, options) => {
      secureTransport = options?.secureTransport;
      expect(address).toEqual({ hostname: "smtp.example.com", port: 587 });
      return makeMockConnect(script)(address, options);
    };
    const result = await sendMailViaSmtp(CONFIG, MESSAGE, connect);
    expect(result).toEqual({ ok: true });
    expect(secureTransport).toBe("starttls");
    const joined = script.commands.join("");
    const order = [
      "EHLO stackmate",
      "STARTTLS",
      "EHLO stackmate",
      "AUTH LOGIN",
      Buffer.from("smtp-user").toString("base64"),
      Buffer.from("smtp-pass-123").toString("base64"),
      "MAIL FROM:<noreply@example.com>",
      "RCPT TO:<admin@example.com>",
      "DATA",
    ];
    let cursor = -1;
    for (const fragment of order) {
      const at = joined.indexOf(fragment, cursor + 1);
      expect(at, `expected ${fragment} in order`).toBeGreaterThan(cursor);
      cursor = at;
    }
    // Dot-stuffing: the text line starting with "." is sent as "..".
    expect(joined).toContain("..Second line starts with a dot.");
    expect(joined).toContain("QUIT");
  });

  it("SSL: implicit TLS, no STARTTLS command", async () => {
    const script: Script = {
      replies: [
        "220 smtp.example.com ESMTP",
        "250 smtp.example.com Hello",
        "334 VXNlcm5hbWU6",
        "334 UGFzc3dvcmQ6",
        "235 Authentication successful",
        "250 OK",
        "250 OK",
        "354 End data with <CR><LF>.<CR><LF>",
        "250 OK queued",
        "221 Bye",
      ],
      commands: [],
    };
    let secureTransport: string | undefined;
    const connect: SmtpConnectFn = (address, options) => {
      secureTransport = options?.secureTransport;
      return makeMockConnect(script)(address, options);
    };
    await sendMailViaSmtp({ ...CONFIG, tlsMode: "ssl", port: 465 }, MESSAGE, connect);
    expect(secureTransport).toBe("on");
    expect(script.commands.join("")).not.toContain("STARTTLS");
  });

  it("none: plain, no AUTH when no username", async () => {
    const script: Script = {
      replies: [
        "220 smtp.example.com ESMTP",
        "250 smtp.example.com Hello",
        "250 OK",
        "250 OK",
        "354 End data with <CR><LF>.<CR><LF>",
        "250 OK queued",
        "221 Bye",
      ],
      commands: [],
    };
    let secureTransport: string | undefined;
    const connect: SmtpConnectFn = (address, options) => {
      secureTransport = options?.secureTransport;
      return makeMockConnect(script)(address, options);
    };
    await sendMailViaSmtp(
      { ...CONFIG, tlsMode: "none", username: "", password: "" },
      MESSAGE,
      connect
    );
    expect(secureTransport).toBe("off");
    expect(script.commands.join("")).not.toContain("AUTH");
  });

  it("port 25 is rejected before connecting", async () => {
    let connected = false;
    const connect: SmtpConnectFn = () => {
      connected = true;
      throw new Error("must not connect");
    };
    await expect(
      sendMailViaSmtp({ ...CONFIG, port: 25 }, MESSAGE, connect)
    ).rejects.toThrow(/Port 25 is blocked/);
    expect(connected).toBe(false);
  });

  it("auth failure throws with the reply code and never the password", async () => {
    const script: Script = {
      replies: [
        "220 smtp.example.com ESMTP",
        "250-smtp.example.com Hello",
        "250-STARTTLS",
        "250 AUTH LOGIN",
        "220 Ready to start TLS",
        "250 smtp.example.com Hello",
        "334 VXNlcm5hbWU6",
        "334 UGFzc3dvcmQ6",
        "535 Authentication failed",
      ],
      commands: [],
    };
    const connect = makeMockConnect(script);
    let caught: unknown;
    try {
      await sendMailViaSmtp(CONFIG, MESSAGE, connect);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SmtpError);
    expect((caught as SmtpError).replyCode).toBe(535);
    expect((caught as Error).message).not.toContain("smtp-pass-123");
    expect((caught as Error).message).not.toContain("smtp-user");
  });

  it("STARTTLS not advertised fails closed", async () => {
    const script: Script = {
      replies: ["220 smtp.example.com ESMTP", "250 smtp.example.com Hello"],
      commands: [],
    };
    const connect = makeMockConnect(script);
    await expect(sendMailViaSmtp(CONFIG, MESSAGE, connect)).rejects.toThrow(
      /does not advertise STARTTLS/
    );
  });

  it("multi-line EHLO reply is parsed (250- continues, 250 ends)", async () => {
    const script = starttlsScript();
    // The second reply is already multi-line in the fixture; assert the
    // client got past it (full success) — the parse is what lets the
    // STARTTLS check see the advertisement on the third line.
    const connect = makeMockConnect(script);
    await expect(sendMailViaSmtp(CONFIG, MESSAGE, connect)).resolves.toEqual({ ok: true });
  });
});

describe("SMTP client timeouts (SMTP timeout fix, 2026-11-16)", () => {
  /**
   * Live 2026-11-16 21:23 +06: "Send test email" against Gmail stayed
   * on "Sending…" for 90+s with no success and no error, while the
   * Worker recorded no invocation near 90s. Before this fix ONLY reads
   * were bounded (READ_TIMEOUT_MS); writer.write(), startTls() and
   * socket.close() could wait forever. Each test below pins one bound
   * with a mock socket that never settles that step: the send must
   * reject (or, for close, resolve) with the real cause inside the
   * budget instead of hanging. Real waits: the step bound is 10s, so
   * each test takes ~10s wall-clock and asserts the elapsed time sits
   * inside the budget — a hang fails the test's own 30s timeout.
   */
  const NONE_CONFIG = {
    host: "smtp.example.com",
    port: 587,
    username: "",
    password: "",
    tlsMode: "none" as const,
  };
  const NONE_REPLIES = [
    "220 smtp.example.com ESMTP",
    "250 smtp.example.com Hello",
    "250 OK",
    "250 OK",
    "354 End data with <CR><LF>.<CR><LF>",
    "250 OK queued",
    "221 Bye",
  ];

  function scriptedSocket(replies: string[], hooks: {
    onWrite?: (chunk: string) => Promise<void> | void;
    close?: () => Promise<void>;
    startTls?: () => SmtpSocketLike;
  } = {}): SmtpSocketLike {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const queue = [...replies];
    // exactOptionalPropertyTypes: `startTls` must not be assigned
    // `undefined` explicitly — add it only when the hook exists.
    const socket: SmtpSocketLike = {
      readable: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const line = queue.shift();
            if (line === undefined) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(`${line}\r\n`));
          },
        },
        { highWaterMark: 0 }
      ),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          const text = decoder.decode(chunk);
          const out = hooks.onWrite?.(text);
          return out instanceof Promise ? out : Promise.resolve();
        },
      }),
      close: hooks.close ?? (() => Promise.resolve()),
    };
    if (hooks.startTls) socket.startTls = hooks.startTls;
    return socket;
  }

  it("write that never resolves: DATA write times out as SmtpError within budget", async () => {
    const never = () => new Promise<void>(() => {});
    const socket = scriptedSocket(NONE_REPLIES, {
      // Hang ONLY the DATA payload (it contains the Subject header);
      // the short commands resolve so the send reaches DATA.
      onWrite: (chunk) => (chunk.includes("Subject: Test") ? never() : undefined),
    });
    const started = Date.now();
    let caught: unknown;
    try {
      await sendMailViaSmtp(NONE_CONFIG, MESSAGE, () => socket);
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;
    expect(caught).toBeInstanceOf(SmtpError);
    expect((caught as Error).message).toMatch(/did not accept the message in time/);
    expect(elapsed).toBeGreaterThanOrEqual(8000);
    expect(elapsed).toBeLessThan(25000);
  }, 30_000);

  it("close that never resolves: send still succeeds (close is cleanup, bounded)", async () => {
    const socket = scriptedSocket(NONE_REPLIES, {
      close: () => new Promise<void>(() => {}),
    });
    const started = Date.now();
    const result = await sendMailViaSmtp(NONE_CONFIG, MESSAGE, () => socket);
    const elapsed = Date.now() - started;
    expect(result).toEqual({ ok: true });
    expect(elapsed).toBeGreaterThanOrEqual(8000);
    expect(elapsed).toBeLessThan(25000);
  }, 30_000);

  it("socket that never connects (no greeting): read timeout surfaces within budget", async () => {
    const socket: SmtpSocketLike = {
      // pull() never enqueues and never closes: the greeting never comes.
      readable: new ReadableStream<Uint8Array>({ pull() {} }, { highWaterMark: 0 }),
      writable: new WritableStream<Uint8Array>({ write() {} }),
      close: () => Promise.resolve(),
    };
    const started = Date.now();
    let caught: unknown;
    try {
      await sendMailViaSmtp(NONE_CONFIG, MESSAGE, () => socket);
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;
    expect(caught).toBeInstanceOf(SmtpError);
    expect((caught as Error).message).toMatch(/did not reply in time/);
    expect(elapsed).toBeGreaterThanOrEqual(8000);
    expect(elapsed).toBeLessThan(25000);
  }, 30_000);

  it("connect that throws synchronously: SmtpError, never a raw throw", async () => {
    const connect: SmtpConnectFn = () => {
      throw new Error("ECONNREFUSED boom");
    };
    await expect(sendMailViaSmtp(NONE_CONFIG, MESSAGE, connect)).rejects.toThrow(
      /Could not open a connection/
    );
  });

  it("startTls that throws synchronously: SmtpError naming the upgrade", async () => {
    const script = starttlsScript();
    const socket = scriptedSocket(script.replies, {
      startTls: () => {
        throw new Error("TLS boom");
      },
    });
    await expect(sendMailViaSmtp(CONFIG, MESSAGE, () => socket)).rejects.toThrow(
      /STARTTLS upgrade failed/
    );
  });

  it("total budget: a server answering every step just under its step timeout still trips the 60s budget", async () => {
    // Fake timers: each scripted reply arrives 9s after it is asked
    // for (just under the 10s per-step read bound), so no single step
    // times out — but the conversation needs ~63s, past the 60s total
    // budget. The send must reject with the total-budget error, not
    // hang and not report success.
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const queue = [...starttlsScript().replies];
      const makeSocket = (): SmtpSocketLike => ({
        readable: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              const line = queue.shift();
              if (line === undefined) {
                controller.close();
                return;
              }
              // 9s per line, on the fake clock.
              setTimeout(() => controller.enqueue(encoder.encode(`${line}\r\n`)), 9000);
            },
          },
          { highWaterMark: 0 }
        ),
        writable: new WritableStream<Uint8Array>({ write() {} }),
        close: () => Promise.resolve(),
        startTls: () => makeSocket(),
      });
      const sendPromise = sendMailViaSmtp(CONFIG, MESSAGE, () => makeSocket());
      // Attach the rejection handler BEFORE advancing the clock: the
      // 60s timer rejects the send while time is being advanced, and
      // a handler attached only afterwards is flagged as an unhandled
      // (late-handled) rejection.
      const assertion = expect(sendPromise).rejects.toThrow(/did not complete in time/);
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});

/**
 * Mocked sockets that fail with RAW (non-SmtpError) throws — the
 * follow-up fix's fault shapes. Shared by the client-level and
 * service-level describes below.
 */
function readErrorSocket(): SmtpSocketLike {
  return {
    readable: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("simulated stream failure"));
      },
    }),
    writable: new WritableStream<Uint8Array>({ write() {} }),
    close: () => Promise.resolve(),
  };
}

function writeErrorSocket(): SmtpSocketLike {
  const encoder = new TextEncoder();
  return {
    readable: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(encoder.encode("220 smtp.example.com ESMTP\r\n"));
          controller.close();
        },
      },
      { highWaterMark: 0 }
    ),
    writable: new WritableStream<Uint8Array>({
      write() {
        return Promise.reject(new Error("simulated write failure"));
      },
    }),
    close: () => Promise.resolve(),
  };
}

function getWriterThrowSocket(): SmtpSocketLike {
  return {
    readable: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.close();
      },
    }),
    writable: {
      getWriter() {
        throw new TypeError("simulated getWriter failure");
      },
    } as unknown as WritableStream<Uint8Array>,
    close: () => Promise.resolve(),
  };
}

function getReaderThrowSocket(): SmtpSocketLike {
  return {
    readable: {
      getReader() {
        throw new TypeError("simulated getReader failure");
      },
    } as unknown as ReadableStream<Uint8Array>,
    writable: new WritableStream<Uint8Array>({ write() {} }),
    close: () => Promise.resolve(),
  };
}

describe("SMTP client raw transport errors (follow-up fix, 2026-11-16)", () => {
  /**
   * Live 2026-11-16 ~22:16 +06: "Send test email" settled (hang fixed)
   * but failed with the generic "Email could not be sent." — that
   * string is the service's non-SmtpError fallback, so the throw was a
   * raw stream TypeError / writer rejection, not an SmtpError. The
   * owner confirmed the mail never arrived, so the failure is pre-DATA
   * (connect → DATA), not post-accept. Every raw throw in the send
   * path must become an SmtpError naming the real cause — never the
   * generic string.
   */
  const NONE_CONFIG = {
    host: "smtp.example.com",
    port: 587,
    username: "",
    password: "",
    tlsMode: "none" as const,
  };

  it("(a) readable stream erroring with a raw TypeError: SmtpError naming the cause", async () => {
    let caught: unknown;
    try {
      await sendMailViaSmtp(NONE_CONFIG, MESSAGE, () => readErrorSocket());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SmtpError);
    expect((caught as Error).message).toBe(
      "SMTP read failed (TypeError: simulated stream failure)."
    );
    expect((caught as Error).message).not.toContain("Email could not be sent");
  });

  it("(b) writer.write rejecting with a raw Error: SmtpError naming the cause", async () => {
    let caught: unknown;
    try {
      await sendMailViaSmtp(NONE_CONFIG, MESSAGE, () => writeErrorSocket());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SmtpError);
    expect((caught as Error).message).toBe(
      "SMTP write failed (Error: simulated write failure)."
    );
    expect((caught as Error).message).not.toContain("Email could not be sent");
  });

  it("(c1) getWriter throwing synchronously: SmtpError naming the cause", async () => {
    let caught: unknown;
    try {
      await sendMailViaSmtp(NONE_CONFIG, MESSAGE, () => getWriterThrowSocket());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SmtpError);
    expect((caught as Error).message).toBe(
      "SMTP stream setup failed (TypeError: simulated getWriter failure)."
    );
    expect((caught as Error).message).not.toContain("Email could not be sent");
  });

  it("(c2) getReader throwing synchronously: SmtpError naming the cause", async () => {
    let caught: unknown;
    try {
      await sendMailViaSmtp(NONE_CONFIG, MESSAGE, () => getReaderThrowSocket());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SmtpError);
    expect((caught as Error).message).toBe(
      "SMTP stream setup failed (TypeError: simulated getReader failure)."
    );
    expect((caught as Error).message).not.toContain("Email could not be sent");
  });
});

describe.skipIf(!DATABASE_URL)(
  "SMTP raw transport errors at the service level (follow-up fix, 2026-11-16)",
  () => {
    /**
     * The generic string "Email could not be sent." lives in
     * sendStackMateEmail's catch (service.ts) — it fires for any
     * non-SmtpError. These tests prove the mapping end to end: the
     * same three raw faults must surface as SmtpError messages naming
     * the real cause, never the generic string. Own fresh database
     * (pattern from auth-email.test.ts); SMTP is seeded via
     * saveSmtpSettings with test-only values, never real credentials.
     */
    const SMTP_ERRORS_DB_NAME = "stackmate_test_smtp_errors";
    let pool: Pool;
    let db: NodePgDatabase<typeof schema>;
    let deps: EmailDeps;
    let adminClient: Client;

    beforeAll(async () => {
      assert.ok(DATABASE_URL, "DATABASE_URL must be set inside this suite");
      const url = new URL(DATABASE_URL);
      assert.ok(
        url.pathname.replace(/^\//, "").includes("test"),
        "Refusing to run: DATABASE_URL database name must contain 'test'."
      );
      const env = resolveRuntimeConfig({ APP_ENV: "test" });

      const maintenanceUrl = new URL(DATABASE_URL);
      maintenanceUrl.pathname = "/postgres";
      const maintenanceClient = new Client({ connectionString: maintenanceUrl.toString() });
      await maintenanceClient.connect();
      await maintenanceClient.query(`DROP DATABASE IF EXISTS "${SMTP_ERRORS_DB_NAME}"`);
      await maintenanceClient.query(`CREATE DATABASE "${SMTP_ERRORS_DB_NAME}"`);
      await maintenanceClient.end();

      const dbUrl = new URL(DATABASE_URL);
      dbUrl.pathname = `/${SMTP_ERRORS_DB_NAME}`;
      const connectionString = dbUrl.toString();
      adminClient = new Client({ connectionString });
      await adminClient.connect();
      const journal = JSON.parse(
        await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")
      ) as { entries: Array<{ tag: string }> };
      for (const entry of journal.entries) {
        const sql = await readFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
        await adminClient.query(sql);
      }

      pool = new Pool({ connectionString });
      db = drizzle(pool, { schema });
      deps = {
        encryptionKey: env.ENCRYPTION_KEY_V1,
        keyVersion: "v1",
        appUrl: "http://localhost:8787",
      };
      await saveSmtpSettings(db, deps, {
        host: "smtp.example.com",
        port: 587,
        username: "",
        password: "smtp-pass-TEST-ONLY",
        tls_mode: "none",
        from_address: "noreply@example.com",
        from_name: "StackMate",
        enabled: true,
      });
    }, 120_000);

    afterAll(async () => {
      try {
        await pool?.end();
      } catch {}
      try {
        await adminClient?.end();
      } catch {}
      try {
        const maintenanceUrl = new URL(DATABASE_URL!);
        maintenanceUrl.pathname = "/postgres";
        const mc = new Client({ connectionString: maintenanceUrl.toString() });
        await mc.connect();
        await mc.query(`DROP DATABASE IF EXISTS "${SMTP_ERRORS_DB_NAME}"`);
        await mc.end();
      } catch {}
    });

    const TEST_MESSAGE = { to: "admin@example.com", subject: "Test", text: "Hello." };

    it("(a) stream erroring with a raw TypeError: service reports the real cause", async () => {
      const result = await sendStackMateEmail(
        db,
        { ...deps, connectImpl: () => readErrorSocket() },
        TEST_MESSAGE
      );
      expect(result.sent).toBe(false);
      expect(result.error).toBe("SMTP read failed (TypeError: simulated stream failure).");
      expect(result.error).not.toBe("Email could not be sent.");
    });

    it("(b) writer.write rejecting with a raw Error: service reports the real cause", async () => {
      const result = await sendStackMateEmail(
        db,
        { ...deps, connectImpl: () => writeErrorSocket() },
        TEST_MESSAGE
      );
      expect(result.sent).toBe(false);
      expect(result.error).toBe("SMTP write failed (Error: simulated write failure).");
      expect(result.error).not.toBe("Email could not be sent.");
    });

    it("(c) getWriter throwing synchronously: service reports the real cause", async () => {
      const result = await sendStackMateEmail(
        db,
        { ...deps, connectImpl: () => getWriterThrowSocket() },
        TEST_MESSAGE
      );
      expect(result.sent).toBe(false);
      expect(result.error).toBe(
        "SMTP stream setup failed (TypeError: simulated getWriter failure)."
      );
      expect(result.error).not.toBe("Email could not be sent.");
    });
  }
);
describe("SMTP client (real local TCP server, TLS mode none)", () => {
  it("sends a message end to end over a real socket", async () => {
    const received: string[] = [];
    let dataBody = "";
    const server: Server = createServer((socket: Socket) => {
      socket.write("220 localhost ESMTP\r\n");
      let buffer = "";
      let inData = false;
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const idx = buffer.indexOf("\r\n");
          if (idx < 0) break;
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              socket.write("250 OK queued\r\n");
            } else {
              dataBody += `${line}\r\n`;
            }
            continue;
          }
          received.push(line);
          if (line.startsWith("EHLO")) socket.write("250 localhost\r\n");
          else if (line.startsWith("MAIL FROM")) socket.write("250 OK\r\n");
          else if (line.startsWith("RCPT TO")) socket.write("250 OK\r\n");
          else if (line === "DATA") {
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
            inData = true;
          } else if (line === "QUIT") {
            socket.write("221 Bye\r\n");
            socket.end();
          } else socket.write("500 Unknown\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const port = address.port;
    try {
      const connect: SmtpConnectFn = () => {
        const socket = netConnect({ host: "127.0.0.1", port });
        return {
          readable: Readable.toWeb(socket as unknown as Readable),
          writable: Writable.toWeb(socket as unknown as Writable),
          close: () => {
            socket.destroy();
            return Promise.resolve();
          },
        } satisfies SmtpSocketLike;
      };
      // Text-only message: no html part, so the DATA body is plain text
      // (no multipart/alternative). Destructured out rather than passed
      // as `html: undefined` — exactOptionalPropertyTypes forbids that.
      const { html: _html, ...textOnly } = MESSAGE;
      const result = await sendMailViaSmtp(
        { host: "127.0.0.1", port, username: "", password: "", tlsMode: "none" },
        textOnly,
        connect
      );
      expect(result).toEqual({ ok: true });
      expect(received).toEqual([
        "EHLO stackmate",
        "MAIL FROM:<noreply@example.com>",
        "RCPT TO:<admin@example.com>",
        "DATA",
        "QUIT",
      ]);
      expect(dataBody).toContain("Subject: Test");
      expect(dataBody).toContain("Hello.");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
