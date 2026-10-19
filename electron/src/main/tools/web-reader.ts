import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface WebResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type PinnedRequester = (url: URL, address: ResolvedAddress, signal: AbortSignal) => Promise<WebResponse>;

const isPrivateIpv4 = (address: string): boolean => {
  const parts = address.split('.').map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 88) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0) ||
    first >= 224
  );
};

const isPrivateAddress = (address: string): boolean => {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  const normalized = address.toLowerCase();
  const mappedIpv4 = normalized.match(/^(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (mappedIpv4 !== undefined && isIP(mappedIpv4) === 4) return isPrivateIpv4(mappedIpv4);
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('100:') ||
    normalized.startsWith('2001:2:') ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('2001:10:') ||
    normalized.startsWith('2001:20:')
  );
};

export const defaultResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => {
    if (record.family !== 4 && record.family !== 6) throw new Error('DNS returned an unsupported address family.');
    return { address: record.address, family: record.family };
  });
};

export const assertSafeHttpsTarget = async (url: URL, resolver: HostResolver): Promise<ResolvedAddress> => {
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) {
    throw new Error('Web reads require an HTTPS URL without embedded credentials.');
  }
  if (url.port !== '' && url.port !== '443') throw new Error('Web reads allow HTTPS port 443 only.');
  const addresses = await resolver(url.hostname);
  if (addresses.length === 0 || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error('Web target resolves to a private, reserved, or unavailable address.');
  }
  const address = addresses[0];
  if (address === undefined) throw new Error('Web target has no address.');
  return address;
};

export const defaultPinnedRequester: PinnedRequester = (url, address, signal) =>
  new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: address.address,
        family: address.family,
        servername: url.hostname,
        port: 443,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: { host: url.host, accept: 'text/html, application/json, text/plain;q=0.9' },
        signal,
      },
      (response) => {
        const headers = Object.fromEntries(
          Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]),
        );
        resolveRequest({ status: response.statusCode ?? 0, headers, body: response });
      },
    );
    request.once('error', rejectRequest);
    request.end();
  });

export interface WebReaderOptions {
  resolver?: HostResolver;
  requester?: PinnedRequester;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export class SecureWebReader {
  readonly #resolver: HostResolver;
  readonly #requester: PinnedRequester;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;

  constructor(options: WebReaderOptions = {}) {
    this.#resolver = options.resolver ?? defaultResolver;
    this.#requester = options.requester ?? defaultPinnedRequester;
    this.#maxBytes = options.maxBytes ?? 1024 * 1024;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxRedirects = options.maxRedirects ?? 3;
  }

  async read(input: string, callerSignal?: AbortSignal): Promise<{ url: string; contentType: string; text: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('Web read timed out.', 'TimeoutError')), this.#timeoutMs);
    const abort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', abort, { once: true });
    try {
      return await this.#read(new URL(input), controller.signal, 0);
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abort);
    }
  }

  async #read(url: URL, signal: AbortSignal, redirects: number): Promise<{ url: string; contentType: string; text: string }> {
    const address = await assertSafeHttpsTarget(url, this.#resolver);
    const response = await this.#requester(url, address, signal);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (location === undefined || redirects >= this.#maxRedirects) throw new Error('Web redirect limit exceeded.');
      return this.#read(new URL(location, url), signal, redirects + 1);
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Web read failed with HTTP ${response.status}.`);
    const contentType = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ?? 'application/octet-stream';
    if (!['application/json', 'text/html', 'text/plain'].includes(contentType)) throw new Error('Web response content type is not supported.');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > this.#maxBytes) throw new Error('Web response exceeds the size limit.');
      chunks.push(bytes);
    }
    return { url: url.toString(), contentType, text: Buffer.concat(chunks).toString('utf8') };
  }
}
