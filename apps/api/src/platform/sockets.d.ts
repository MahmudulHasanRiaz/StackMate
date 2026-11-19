/**
 * Ambient declaration for the Cloudflare Workers TCP sockets runtime
 * module (`cloudflare:sockets`).
 *
 * Shape verified against @cloudflare/workers-types 5.20261115.1
 * (node_modules/@cloudflare/workers-types, `declare module
 * "cloudflare:sockets"`) and the official docs
 * (developers.cloudflare.com/workers/runtime-apis/tcp-sockets/). This
 * local declaration exists because the API tsconfig does not reference
 * workers-types (pulling the whole file in would drag its global scope
 * into the Node/vitest typecheck); it declares exactly the `connect`
 * surface the SMTP client uses. Wrangler resolves the real module at
 * deploy time — the dry-run step in verify-batch1.sh proves it.
 */
declare module "cloudflare:sockets" {
  export interface SocketAddress {
    hostname: string;
    port: number;
  }
  export interface SocketOptions {
    secureTransport?: "off" | "on" | "starttls";
    allowHalfOpen?: boolean;
  }
  export interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly opened: Promise<{ remoteAddress: string | null; localAddress: string | null }>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
    startTls(): Socket;
  }
  export function connect(
    address: SocketAddress | string,
    options?: SocketOptions
  ): Socket;
}
