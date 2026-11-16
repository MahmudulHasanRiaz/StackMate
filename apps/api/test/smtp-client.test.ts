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
import { describe, it, expect } from "vitest";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import {
  sendMailViaSmtp,
  SmtpError,
  type SmtpConnectFn,
  type SmtpMessage,
  type SmtpSocketLike,
} from "../src/modules/email/smtp-client.ts";

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
