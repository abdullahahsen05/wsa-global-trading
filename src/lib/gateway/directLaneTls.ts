/**
 * The direct lane's transport security - without a certificate to buy, install, renew or copy from one machine to another.
 *
 * The web server and the AWS worker already share a secret (`WSA_TRADE_DIRECT_SECRET`, >= 32 characters) that signs every
 * request and every answer. That secret is also enough to give the two ends an encrypted channel that nobody in between
 * can read or change - a TLS identity both sides can work out for themselves:
 *
 *   secret --HKDF-SHA256--> a 32-byte seed --> an Ed25519 key pair --> a self-signed X.509 certificate
 *
 * The worker serves HTTPS with that key and certificate; the web server trusts exactly that certificate (and, for an address
 * that is behind a proxy with an ordinary certificate, the usual public authorities - see `directLaneClientTls`). Ed25519
 * signatures are deterministic, so both ends compute the very same certificate bytes. Nothing is written to disk, nothing
 * is pasted into a settings page, and an IP address that changes after a restart of the machine breaks nothing (the
 * certificate is checked by its KEY, not by the name or address it was reached under).
 *
 * What this protects against: somebody on the network between Vercel and AWS reading the orders or answering in the
 * worker's name. They would need the private key, and that exists only as long as the secret does. What it does not change:
 * whoever knows the secret can already sign orders - the secret stays the one thing to keep private (rotate it by changing
 * it on both sides). Rotating the secret rotates the key and the certificate with it.
 *
 * Pure apart from `node:crypto` / `node:tls`: no Next / React imports, shared by the web app and the AWS worker.
 */

import { createPrivateKey, createPublicKey, hkdfSync, sign, timingSafeEqual, X509Certificate } from "node:crypto";
import * as tls from "node:tls";

export interface DirectLaneIdentity {
  /** the self-signed certificate (public) */
  certPem: string;
  /** its private key, PKCS#8 (never leaves the process) */
  keyPem: string;
  /** SubjectPublicKeyInfo (DER) of the key: what the certificate of the other end is compared with */
  spki: Buffer;
}

// ── DER (just enough ASN.1 to write one certificate) ─────────────────────────────

function lengthBytes(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x100) return Buffer.from([0x81, length]);
  if (length < 0x10000) return Buffer.from([0x82, length >> 8, length & 0xff]);
  throw new Error("DER value too long");
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthBytes(body.length), body]);
}

const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
const set = (...parts: Buffer[]): Buffer => tlv(0x31, ...parts);
const oid = (bytes: number[]): Buffer => tlv(0x06, Buffer.from(bytes));
const explicit = (n: number, ...parts: Buffer[]): Buffer => tlv(0xa0 + n, ...parts);
const TRUE = tlv(0x01, Buffer.from([0xff]));

/** 1.3.101.112 (Ed25519) */
const OID_ED25519 = [0x2b, 0x65, 0x70];
/** 2.5.4.3 (commonName) */
const OID_COMMON_NAME = [0x55, 0x04, 0x03];
/** 2.5.29.19 (basicConstraints) */
const OID_BASIC_CONSTRAINTS = [0x55, 0x1d, 0x13];
/** 2.5.29.15 (keyUsage) */
const OID_KEY_USAGE = [0x55, 0x1d, 0x0f];
/** PKCS#8 wrapper of a raw Ed25519 seed (RFC 8410): the 32 seed bytes follow */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const COMMON_NAME = "wsa-direct-lane";
/** Fixed on purpose: the same secret must give the same certificate on both sides, today and in ten years. */
const NOT_BEFORE = "200101000000Z";
const NOT_AFTER = "20991231235959Z";
const HKDF_SALT = "wsa-direct-lane/v1";
const HKDF_INFO = "tls-identity";

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function build(secret: string): DirectLaneIdentity {
  const seed = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(HKDF_SALT), Buffer.from(HKDF_INFO), 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });

  // A positive serial number of eight bytes taken from the key itself (the first byte 0x40 - 0x7f: positive and minimal).
  const serial = Buffer.from(spki.subarray(spki.length - 8));
  serial[0] = (serial[0] & 0x3f) | 0x40;

  const name = sequence(set(sequence(oid(OID_COMMON_NAME), tlv(0x0c, Buffer.from(COMMON_NAME, "utf8")))));
  const algorithm = sequence(oid(OID_ED25519));
  const extensions = explicit(
    3,
    sequence(
      // CA:TRUE - the certificate is its own trust anchor on the web side
      sequence(oid(OID_BASIC_CONSTRAINTS), TRUE, tlv(0x04, sequence(TRUE))),
      // digitalSignature + keyCertSign
      sequence(oid(OID_KEY_USAGE), TRUE, tlv(0x04, tlv(0x03, Buffer.from([0x02, 0x84])))),
    ),
  );
  const toBeSigned = sequence(
    explicit(0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    algorithm,
    name,
    sequence(tlv(0x17, Buffer.from(NOT_BEFORE, "ascii")), tlv(0x18, Buffer.from(NOT_AFTER, "ascii"))),
    name,
    spki,
    extensions,
  );
  const signature = sign(null, toBeSigned, privateKey);
  const certificate = sequence(toBeSigned, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));

  return {
    certPem: pem("CERTIFICATE", certificate),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    spki,
  };
}

const identities = new Map<string, DirectLaneIdentity>();

/**
 * The TLS identity of a direct lane with this secret. The same secret always gives the same key and certificate; a different
 * secret gives unrelated ones. (Computed once per secret and kept - it costs a few milliseconds.)
 */
export function deriveDirectLaneIdentity(secret: string): DirectLaneIdentity {
  const key = secret.trim();
  const known = identities.get(key);
  if (known) return known;
  const made = build(key);
  if (identities.size >= 4) identities.clear();
  identities.set(key, made);
  return made;
}

// ── the worker's side ────────────────────────────────────────────────────────────

/** What the worker's HTTPS server is started with. */
export function directLaneServerTls(secret: string): { key: string; cert: string; minVersion: "TLSv1.2"; handshakeTimeout: number } {
  const identity = deriveDirectLaneIdentity(secret);
  // (a connection that does not finish its handshake within seconds is cut loose: the port is reachable from the internet)
  return { key: identity.keyPem, cert: identity.certPem, minVersion: "TLSv1.2", handshakeTimeout: 5_000 };
}

// ── the web server's side ────────────────────────────────────────────────────────

export interface DirectLaneClientTls {
  secureContext: tls.SecureContext;
  checkServerIdentity: (hostname: string, peer: tls.PeerCertificate) => Error | undefined;
}

/** Does this certificate carry exactly the key the secret gives the worker? */
export function certificateHasKey(raw: Buffer | undefined, spki: Buffer): boolean {
  if (!raw || raw.length === 0) return false;
  try {
    const presented = new X509Certificate(raw).publicKey.export({ type: "spki", format: "der" });
    return presented.length === spki.length && timingSafeEqual(presented, spki);
  } catch {
    return false;
  }
}

const clients = new Map<string, DirectLaneClientTls>();

/**
 * How the web server checks the worker it connects to. It trusts
 *   - the certificate the secret gives the worker (checked by its KEY: the address or name used to reach the machine does
 *     not matter, so a changing IP address or no domain at all is fine), and
 *   - the public certificate authorities, with the ordinary host-name check, for an address that sits behind a proxy
 *     (Cloudflare tunnel, a load balancer, Caddy ...) which presents a certificate of its own.
 * Anything else is refused before a single byte of the order is written.
 */
export function directLaneClientTls(secret: string): DirectLaneClientTls {
  const key = secret.trim();
  const known = clients.get(key);
  if (known) return known;
  const identity = deriveDirectLaneIdentity(key);
  const made: DirectLaneClientTls = {
    secureContext: tls.createSecureContext({ ca: [identity.certPem, ...tls.rootCertificates], minVersion: "TLSv1.2" }),
    checkServerIdentity: (hostname, peer) => {
      if (certificateHasKey(peer.raw, identity.spki)) return undefined;
      return tls.checkServerIdentity(hostname, peer);
    },
  };
  if (clients.size >= 4) clients.clear();
  clients.set(key, made);
  return made;
}
