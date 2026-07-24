// SSRF guard for user-supplied URLs (LLM base URLs, self-hosted git
// instances, clone URLs). Rejects non-http(s) schemes and destinations that
// are — or resolve to — loopback, RFC1918, link-local, cgNAT, or reserved
// addresses. Config-free on purpose (same rule as utils.ts): the local-dev
// escape hatch is the ALLOW_PRIVATE_URLS env var read at call time.
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

// [start, end] inclusive, dotted-quad as 32-bit numbers.
const PRIVATE_V4_RANGES: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8 "this host"
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x64400000, 0x647fffff], // 100.64.0.0/10 cgNAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 loopback
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local (incl. cloud metadata)
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 benchmarking
  [0xe0000000, 0xefffffff], // 224.0.0.0/4 multicast
  [0xf0000000, 0xffffffff], // 240.0.0.0/4 reserved
];

function ipv4ToLong(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const value = ipv4ToLong(ip);
  return PRIVATE_V4_RANGES.some(([start, end]) => value >= start && value <= end);
}

function isPrivateV6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateV4(mapped);
  return normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized);
}

// True when `ip` is an IP literal in a private/loopback/reserved range.
// Non-IP input (hostnames, empty strings) returns false — callers route
// hostnames through resolvesToPrivateIp instead.
export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return false;
}

// Resolves a hostname and reports whether ANY address is private. Failing
// closed on "any" blocks dual-homed hostnames that mix public and private
// records. IP literals skip DNS entirely.
export async function resolvesToPrivateIp(hostname: string): Promise<boolean> {
  if (isIP(hostname) !== 0) return isPrivateIp(hostname);
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.some((record) => isPrivateIp(record.address));
}

function privateUrlsAllowed(override?: boolean): boolean {
  if (override !== undefined) return override;
  return process.env.ALLOW_PRIVATE_URLS === 'true';
}

// Parses `rawUrl` and asserts it is an http(s) URL whose host neither is nor
// resolves to a private address. Returns the parsed URL on success; throws
// otherwise. `allowPrivate` overrides the env escape hatch (tests).
export async function assertPublicHttpUrl(
  rawUrl: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`URL scheme '${url.protocol}' is not allowed (http/https only)`);
  }
  if (privateUrlsAllowed(opts.allowPrivate)) return url;
  if (await resolvesToPrivateIp(url.hostname)) {
    throw new Error(`URL host '${url.hostname}' is a private or reserved address`);
  }
  return url;
}
