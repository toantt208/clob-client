import http2 from "node:http2";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";

export interface H2PoolOptions {
    /** Ping interval to keep connection alive (default: 15s) */
    pingIntervalMs?: number;
    /** Per-request timeout (default: 10s) */
    requestTimeoutMs?: number;
    /** Max retries on transient connection errors (default: 2) */
    maxRetries?: number;
    /** Max concurrent streams per session before opening a new one (default: 100) */
    maxStreamsPerSession?: number;
    /** Max number of sessions in the pool (default: unlimited) */
    maxSessions?: number;
}

export interface H2Response {
    status: number;
    data: any;
}

const RETRYABLE_CODES = new Set([
    "ERR_HTTP2_GOAWAY_SESSION",
    "ERR_HTTP2_INVALID_SESSION",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENETUNREACH",
    "EAI_AGAIN",
]);

interface ManagedSession {
    session: http2.ClientHttp2Session;
    activeStreams: number;
    pingTimer: ReturnType<typeof setInterval> | null;
    maxConcurrent: number; // from server SETTINGS
}

export class H2Pool {
    private origin: string;
    private pingIntervalMs: number;
    private requestTimeoutMs: number;
    private maxRetries: number;
    private maxStreamsPerSession: number;
    private maxSessions: number;

    private sessions: ManagedSession[] = [];
    private connectingPromise: Promise<ManagedSession> | null = null;
    private pendingCreates = 0;

    stats = { tlsConns: 0, requests: 0, reconnects: 0 };

    constructor(origin: string, opts: H2PoolOptions = {}) {
        this.origin = origin;
        this.pingIntervalMs = opts.pingIntervalMs ?? 15_000;
        this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
        this.maxRetries = opts.maxRetries ?? 2;
        this.maxStreamsPerSession = opts.maxStreamsPerSession ?? 20;
        this.maxSessions = opts.maxSessions ?? Infinity;
    }

    // Pick the session with the fewest active streams that still has capacity
    private pickSession(): ManagedSession | null {
        // Remove dead sessions
        this.sessions = this.sessions.filter(
            (ms) => !ms.session.closed && !ms.session.destroyed,
        );

        let best: ManagedSession | null = null;
        for (const ms of this.sessions) {
            const limit = Math.min(ms.maxConcurrent, this.maxStreamsPerSession);
            if (ms.activeStreams < limit) {
                if (!best || ms.activeStreams < best.activeStreams) {
                    best = ms;
                }
            }
        }
        return best;
    }

    private async getSession(): Promise<ManagedSession> {
        const existing = this.pickSession();
        if (existing) {
            existing.activeStreams++;
            return existing;
        }

        // All sessions are full — create a new one if allowed
        // pendingCreates is incremented synchronously before the await so
        // concurrent callers in the same microtask see the updated count
        if (this.sessions.length + this.pendingCreates < this.maxSessions) {
            this.pendingCreates++;
            try {
                const ms = await this.createSession();
                ms.activeStreams++;
                return ms;
            } finally {
                this.pendingCreates--;
            }
        }

        // At max sessions — return the least loaded one (will queue in HTTP/2)
        let best: ManagedSession | null = null;
        for (const ms of this.sessions) {
            if (!best || ms.activeStreams < best.activeStreams) {
                best = ms;
            }
        }
        if (best) {
            best.activeStreams++;
            return best;
        }

        // Fallback — all dead, create fresh
        this.pendingCreates++;
        try {
            const ms = await this.createSession();
            ms.activeStreams++;
            return ms;
        } finally {
            this.pendingCreates--;
        }
    }

    private createSession(): Promise<ManagedSession> {
        // Only dedup if we have no existing sessions at all (first connect or full reconnect)
        if (this.connectingPromise && this.sessions.length === 0) return this.connectingPromise;

        this.stats.tlsConns++;
        if (this.stats.tlsConns > 1 && this.sessions.length === 0) {
            this.stats.reconnects++;
        }

        this.connectingPromise = new Promise<ManagedSession>((resolve, reject) => {
            const session = http2.connect(this.origin);
            const ms: ManagedSession = {
                session,
                activeStreams: 0,
                pingTimer: null,
                maxConcurrent: this.maxStreamsPerSession,
            };

            session.once("connect", () => {
                this.connectingPromise = null;
                this.sessions.push(ms);
                this.startPing(ms);

                // Update maxConcurrent from server settings
                const serverMax = session.remoteSettings?.maxConcurrentStreams;
                if (serverMax && serverMax < ms.maxConcurrent) {
                    ms.maxConcurrent = serverMax;
                }

                resolve(ms);
            });

            session.once("error", (err) => {
                this.connectingPromise = null;
                this.removeSession(ms);
                reject(err);
            });

            session.once("goaway", () => {
                this.removeSession(ms);
            });

            session.once("close", () => {
                this.removeSession(ms);
            });
        });

        return this.connectingPromise;
    }

    private removeSession(ms: ManagedSession): void {
        if (ms.pingTimer) {
            clearInterval(ms.pingTimer);
            ms.pingTimer = null;
        }
        if (!ms.session.destroyed) {
            try {
                ms.session.close();
            } catch {
                // ignore
            }
        }
        this.sessions = this.sessions.filter((s) => s !== ms);
    }

    private startPing(ms: ManagedSession): void {
        ms.pingTimer = setInterval(() => {
            if (ms.session.closed || ms.session.destroyed) {
                this.removeSession(ms);
                return;
            }
            ms.session.ping((err: Error | null) => {
                if (err) {
                    this.removeSession(ms);
                }
            });
        }, this.pingIntervalMs);
        ms.pingTimer.unref();
    }

    async request(
        method: string,
        url: string,
        headers: Record<string, string | number | boolean> = {},
        body?: any,
    ): Promise<H2Response> {
        let lastErr: Error | undefined;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                return await this.doRequest(method, url, headers, body);
            } catch (err: any) {
                lastErr = err;
                const code = err?.code ?? "";
                const msg = err?.message ?? "";
                const isRetryable =
                    RETRYABLE_CODES.has(code) || msg.includes("closed") || msg.includes("destroyed");
                if (!isRetryable || attempt >= this.maxRetries) throw err;
            }
        }
        throw lastErr;
    }

    private doRequest(
        method: string,
        url: string,
        headers: Record<string, string | number | boolean>,
        body?: any,
    ): Promise<H2Response> {
        return new Promise(async (resolve, reject) => {
            this.stats.requests++;
            const parsed = new URL(url);
            const path = parsed.pathname + parsed.search;

            let ms: ManagedSession;
            try {
                ms = await this.getSession();
            } catch (err) {
                return reject(err);
            }

            // HTTP/2 requires lowercase header names
            const h2Headers: http2.OutgoingHttpHeaders = {
                [http2.constants.HTTP2_HEADER_METHOD]: method,
                [http2.constants.HTTP2_HEADER_PATH]: path,
            };
            for (const [k, v] of Object.entries(headers)) {
                h2Headers[k.toLowerCase()] = String(v);
            }

            const req = ms.session.request(h2Headers);

            const done = () => {
                ms.activeStreams--;
            };

            const timer = setTimeout(() => {
                done();
                req.close(http2.constants.NGHTTP2_CANCEL);
                reject(Object.assign(new Error("request timeout"), { code: "ETIMEDOUT" }));
            }, this.requestTimeoutMs);

            const chunks: Buffer[] = [];
            req.on("response", (responseHeaders) => {
                req.on("data", (chunk: Buffer) => {
                    chunks.push(chunk);
                });
                req.on("end", () => {
                    clearTimeout(timer);
                    done();
                    const status = (responseHeaders[":status"] as number) ?? 0;
                    let raw = Buffer.concat(chunks);
                    const encoding = responseHeaders["content-encoding"] as string | undefined;
                    if (encoding === "gzip" || encoding === "x-gzip") {
                        raw = gunzipSync(raw);
                    } else if (encoding === "deflate") {
                        raw = inflateSync(raw);
                    } else if (encoding === "br") {
                        raw = brotliDecompressSync(raw);
                    }
                    const text = raw.toString("utf8");
                    try {
                        resolve({ status, data: JSON.parse(text) });
                    } catch {
                        resolve({ status, data: text });
                    }
                });
            });

            req.on("error", (err) => {
                clearTimeout(timer);
                done();
                reject(err);
            });

            if (body !== undefined && body !== null) {
                req.write(typeof body === "string" ? body : JSON.stringify(body));
            }
            req.end();
        });
    }

    async warmup(n: number): Promise<void> {
        const toCreate = Math.min(n, this.maxSessions) - this.sessions.length;
        if (toCreate <= 0) return;
        await Promise.all(
            Array.from({ length: toCreate }, () => this.createSession()),
        );
    }

    close(): void {
        for (const ms of this.sessions) {
            if (ms.pingTimer) {
                clearInterval(ms.pingTimer);
                ms.pingTimer = null;
            }
            if (!ms.session.destroyed) {
                try {
                    ms.session.close();
                } catch {
                    // ignore
                }
            }
        }
        this.sessions = [];
    }
}
