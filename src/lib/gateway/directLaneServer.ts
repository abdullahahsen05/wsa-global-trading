if (typeof window !== "undefined") {
  throw new Error("[wsa] directLaneServer is server-only.");
}

/**
 * The HTTP side of the direct lane (see `directLane.ts`): a small `node:http` server inside the AWS copy worker.
 *
 *   POST /v1/trade    one order / change from the web server; answered when the broker has answered
 *   GET  /v1/health   "I am here" - signed like an order, so a stranger learns nothing; the web server uses it to
 *                     keep its connection open (the first order after a quiet moment would otherwise start with a
 *                     TCP + TLS handshake)
 *
 * Everything else is a 404 without a body. A request is only looked at after its signature has been checked, and
 * nothing is run for a request that is too old, too big or from somebody who does not know the secret.
 *
 * No Next / React imports: runs inside the AWS worker.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import {
  checkDirectAuth,
  DIRECT_HEALTH_PATH,
  DIRECT_LANE_VERSION,
  DIRECT_MAX_BODY_BYTES,
  DIRECT_PATH,
  DIRECT_SIGNATURE_HEADER,
  DIRECT_TIMESTAMP_HEADER,
  parseDirectRequest,
  signDirect,
  type DirectReply,
  type DirectRequest,
  type DirectWireReply,
} from "./directLane";
import { directLaneServerTls } from "./directLaneTls";

export interface DirectLaneServerOptions {
  secret: string;
  port: number;
  /** the address to listen on; "0.0.0.0" = every interface (use "127.0.0.1" behind a local reverse proxy) */
  host?: string;
  /**
   * Serve HTTPS with the key and certificate the secret gives (`directLaneTls.ts`). Default: false, plain HTTP - for a
   * port that only a local reverse proxy reaches. The worker turns it on unless `WSA_TRADE_DIRECT_TLS=off`.
   */
  tls?: boolean;
  /** runs one order (the gateway worker's `runDirect`) */
  run: (request: DirectRequest, receivedAt: number) => Promise<DirectReply>;
  now?: () => number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /** orders being handled at the same time; more are refused (nothing is sent for them) */
  maxInFlight?: number;
}

export interface DirectLaneServer {
  readonly port: number;
  /** the port serves HTTPS (the heartbeat tells the web server, which checks its address against it) */
  readonly tls: boolean;
  close(): Promise<void>;
}

class BodyTooLarge extends Error {}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge());
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function headerOf(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function send(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
}

/**
 * Starts listening. Resolves once the port is open; rejects when it can not be opened (in use, no permission),
 * in which case the worker simply goes on without the direct lane.
 */
export function startDirectLaneServer(options: DirectLaneServerOptions): Promise<DirectLaneServer> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(message));
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const maxInFlight = Math.max(1, options.maxInFlight ?? 64);
  let inFlight = 0;
  let authFailureLoggedAt = 0;

  /** A signed answer: the web server only believes an answer that carries the signature of the shared secret. */
  const sendSigned = (response: ServerResponse, status: number, timestamp: string, body: string) => {
    send(response, status, body, {
      [DIRECT_TIMESTAMP_HEADER]: timestamp,
      [DIRECT_SIGNATURE_HEADER]: signDirect(options.secret, timestamp, body),
    });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const receivedAt = now();
    const path = (request.url ?? "").split("?")[0];
    const isHealth = request.method === "GET" && path === DIRECT_HEALTH_PATH;
    const isTrade = request.method === "POST" && path === DIRECT_PATH;
    if (!isHealth && !isTrade) {
      send(response, 404, "");
      return;
    }

    let body = "";
    if (isTrade) {
      try {
        body = await readBody(request, DIRECT_MAX_BODY_BYTES);
      } catch (error) {
        const tooLarge = error instanceof BodyTooLarge;
        send(response, tooLarge ? 413 : 400, JSON.stringify({ ok: false, code: "DIRECT_BAD_REQUEST", notSent: true }));
        return;
      }
    }

    const timestamp = headerOf(request, DIRECT_TIMESTAMP_HEADER);
    const auth = checkDirectAuth(
      options.secret,
      { timestamp, signature: headerOf(request, DIRECT_SIGNATURE_HEADER) },
      body,
      receivedAt,
    );
    if (auth !== "ok" || timestamp === null) {
      // (logged at most once a minute: a stranger must not be able to fill the log)
      if (receivedAt - authFailureLoggedAt > 60_000) {
        authFailureLoggedAt = receivedAt;
        warn(`[trade-gateway] direct lane: a request was refused (${auth}). If the web server's secret or clock is wrong, orders fall back to the database.`);
      }
      send(response, 401, JSON.stringify({ ok: false, code: `DIRECT_AUTH_${auth.toUpperCase()}`, notSent: true }));
      return;
    }

    if (isHealth) {
      sendSigned(response, 200, timestamp, JSON.stringify({ v: DIRECT_LANE_VERSION, ok: true, at: receivedAt }));
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      send(response, 400, JSON.stringify({ ok: false, code: "DIRECT_BAD_REQUEST", notSent: true }));
      return;
    }
    const parsed = parseDirectRequest(parsedBody);
    if (!parsed.ok) {
      send(response, 400, JSON.stringify({ ok: false, code: "DIRECT_BAD_REQUEST", message: parsed.message, notSent: true }));
      return;
    }
    if (inFlight >= maxInFlight) {
      send(response, 503, JSON.stringify({ ok: false, code: "DIRECT_BUSY", notSent: true }));
      return;
    }

    inFlight += 1;
    try {
      const reply = await options.run(parsed.request, receivedAt);
      const wire: DirectWireReply = { v: DIRECT_LANE_VERSION, clientRequestId: parsed.request.clientRequestId, reply };
      sendSigned(response, 200, timestamp, JSON.stringify(wire));
    } catch (error) {
      // (`run` does not throw; if it ever does the order may or may not exist - the web server treats a 500 as uncertain)
      warn(`[trade-gateway] direct lane: handling a request failed: ${error instanceof Error ? error.message : "unknown error"}`);
      send(response, 500, JSON.stringify({ ok: false, code: "DIRECT_INTERNAL" }));
    } finally {
      inFlight -= 1;
    }
  };

  const onRequest = (request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, JSON.stringify({ ok: false, code: "DIRECT_INTERNAL" }));
    });
  };
  const secure = options.tls === true;
  // (an HTTPS server has every member used below; the typings just do not make it a subtype of the plain one)
  const server = (secure
    ? createSecureServer(directLaneServerTls(options.secret), onRequest)
    : createServer(onRequest)) as unknown as Server;
  // Connections stay open between orders (the web server keeps them warm), and a stalled one is cut loose.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxConnections = 256;
  // the order is small and the answer is one write: no waiting for more data to fill a packet
  server.on("connection", (socket) => socket.setNoDelay(true));
  // A stranger that starts a handshake and gives up, or speaks plain HTTP to the secure port, is not worth a line in the log.
  if (secure) server.on("tlsClientError", () => undefined);

  return new Promise<DirectLaneServer>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.off("error", failed);
      server.on("error", (error) => warn(`[trade-gateway] direct lane server error: ${error.message}`));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      log(
        `[trade-gateway] direct lane listening on ${options.host ?? "0.0.0.0"}:${port} over ${secure ? "HTTPS (key from the shared secret)" : "plain HTTP (put a TLS proxy in front)"} - orders from the web server skip the database.`,
      );
      resolve({
        port,
        tls: secure,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // idle keep-alive connections would hold the close for a minute
            server.closeIdleConnections?.();
            setTimeout(() => {
              server.closeAllConnections?.();
              done();
            }, 2_000).unref();
          }),
      });
    });
  });
}
