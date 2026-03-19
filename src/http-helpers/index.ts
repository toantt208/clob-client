import { isBrowser } from "browser-or-node";
import type { H2Pool } from "../h2pool.ts";
import type {
    DropNotificationParams,
    GetRfqQuotesParams,
    GetRfqRequestsParams,
    OrdersScoringParams,
    SimpleHeaders,
} from "../types.ts";

export const GET = "GET";
export const POST = "POST";
export const DELETE = "DELETE";
export const PUT = "PUT";

// ── Shared H2Pool instance (set by ClobClient constructor) ──
let _pool: H2Pool | null = null;

export const setH2Pool = (pool: H2Pool): void => {
    _pool = pool;
};

export const getH2Pool = (): H2Pool | null => _pool;

const buildUrl = (endpoint: string, params?: QueryParams): string => {
    if (!params || Object.keys(params).length === 0) return endpoint;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const s = qs.toString();
    return s ? `${endpoint}?${s}` : endpoint;
};

const prepareHeaders = (_method: string, headers?: SimpleHeaders): SimpleHeaders => {
    const h: SimpleHeaders = { ...headers };
    if (!isBrowser) {
        h["user-agent"] = "@polymarket/clob-client";
        h["content-type"] = "application/json";
        h["accept-encoding"] = "gzip";
    }
    return h;
};

export class HttpError extends Error {
    status: number;
    data: any;
    response: { status: number; statusText: string; data: any; config: any };

    constructor(status: number, data: any, url: string, method: string) {
        const msg = typeof data === "object" && data?.error ? data.error : `HTTP ${status}`;
        super(msg);
        this.status = status;
        this.data = data;
        this.response = {
            status,
            statusText: `${status}`,
            data,
            config: { method, url },
        };
    }
}

export const request = async (
    endpoint: string,
    method: string,
    headers?: SimpleHeaders,
    data?: any,
    params?: any,
): Promise<any> => {
    if (!_pool) throw new Error("H2Pool not initialized. Call setH2Pool() first.");
    const url = buildUrl(endpoint, params);
    const h = prepareHeaders(method, headers);
    const t0 = Date.now();
    const resp = await _pool.request(method, url, h, data);
    console.log(`[H2] ${method} ${url} → ${resp.status} (${Date.now() - t0}ms) [TLS: ${_pool.stats.tlsConns}]`);
    if (resp.status >= 400) {
        throw new HttpError(resp.status, resp.data, url, method);
    }
    return { data: resp.data, status: resp.status };
};

export type QueryParams = Record<string, any>;

export interface RequestOptions {
    headers?: SimpleHeaders;
    data?: any;
    params?: QueryParams;
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

const isTransientError = (err: unknown): boolean => {
    if (!(err instanceof Error)) return false;
    if (err instanceof HttpError) {
        return err.status >= 500 && err.status < 600;
    }
    const code = (err as any).code ?? "";
    return ["ECONNABORTED", "ENETUNREACH", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET"].includes(code);
};

export const post = async (
    endpoint: string,
    options?: RequestOptions,
    retryOnError?: boolean,
): Promise<any> => {
    try {
        const resp = await request(
            endpoint,
            POST,
            options?.headers,
            options?.data,
            options?.params,
        );
        return resp.data;
    } catch (err: unknown) {
        if (retryOnError && isTransientError(err)) {
            console.log("[CLOB Client] transient error, retrying once after 30 ms");
            await sleep(30);
            try {
                const resp = await request(
                    endpoint,
                    POST,
                    options?.headers,
                    options?.data,
                    options?.params,
                );
                return resp.data;
            } catch (retryErr: unknown) {
                return errorHandling(retryErr);
            }
        }
        return errorHandling(err);
    }
};

export const get = async (endpoint: string, options?: RequestOptions): Promise<any> => {
    try {
        const resp = await request(endpoint, GET, options?.headers, options?.data, options?.params);
        return resp.data;
    } catch (err: unknown) {
        return errorHandling(err);
    }
};

export const del = async (endpoint: string, options?: RequestOptions): Promise<any> => {
    try {
        const resp = await request(
            endpoint,
            DELETE,
            options?.headers,
            options?.data,
            options?.params,
        );
        return resp.data;
    } catch (err: unknown) {
        return errorHandling(err);
    }
};

export const put = async (endpoint: string, options?: RequestOptions): Promise<any> => {
    try {
        const resp = await request(endpoint, PUT, options?.headers, options?.data, options?.params);
        return resp.data;
    } catch (err: unknown) {
        return errorHandling(err);
    }
};

const errorHandling = (err: unknown) => {
    if (err instanceof HttpError) {
        console.error(
            "[CLOB Client] request error",
            JSON.stringify({
                status: err.status,
                statusText: err.response.statusText,
                data: err.data,
                config: err.response.config,
            }),
        );
        const data = err.data;
        if (data) {
            if (typeof data === "string" || data instanceof String) {
                return { error: data, status: err.status };
            }
            if (!Object.hasOwn(data, "error")) {
                return { error: data, status: err.status };
            }
            return { ...data, status: err.status };
        }
    }

    if (err instanceof Error) {
        if (err.message) {
            console.error(
                "[CLOB Client] request error",
                JSON.stringify({ error: err.message }),
            );
            return { error: err.message };
        }
    }

    console.error("[CLOB Client] request error", err);
    return { error: err };
};

export const parseOrdersScoringParams = (orderScoringParams?: OrdersScoringParams): QueryParams => {
    const params: QueryParams = {};
    if (orderScoringParams !== undefined) {
        if (orderScoringParams.orderIds !== undefined) {
            params.order_ids = orderScoringParams?.orderIds.join(",");
        }
    }
    return params;
};

export const parseDropNotificationParams = (
    dropNotificationParams?: DropNotificationParams,
): QueryParams => {
    const params: QueryParams = {};
    if (dropNotificationParams !== undefined) {
        if (dropNotificationParams.ids !== undefined) {
            params.ids = dropNotificationParams?.ids.join(",");
        }
    }
    return params;
};

export const parseRfqQuotesParams = (rfqQuotesParams?: GetRfqQuotesParams): QueryParams => {
    if (!rfqQuotesParams) return {};

    const params: QueryParams = { ...rfqQuotesParams };

    // Convert array fields to comma-separated strings
    if (rfqQuotesParams.quoteIds) {
        params.quoteIds = rfqQuotesParams.quoteIds.join(",");
    }
    if (rfqQuotesParams.markets) {
        params.markets = rfqQuotesParams.markets.join(",");
    }
    if (rfqQuotesParams.requestIds) {
        params.requestIds = rfqQuotesParams.requestIds.join(",");
    }

    return params;
};

export const parseRfqRequestsParams = (rfqRequestsParams?: GetRfqRequestsParams): QueryParams => {
    if (!rfqRequestsParams) return {};

    const params: QueryParams = { ...rfqRequestsParams };

    // Convert array fields to comma-separated strings
    if (rfqRequestsParams.requestIds) {
        params.requestIds = rfqRequestsParams.requestIds.join(",");
    }
    if (rfqRequestsParams.markets) {
        params.markets = rfqRequestsParams.markets.join(",");
    }

    return params;
};
