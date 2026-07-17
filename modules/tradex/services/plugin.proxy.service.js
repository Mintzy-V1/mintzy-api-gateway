import { Readable } from "stream";
import logger from "../config/logger.js";

const PLUGIN_BASE = process.env.PLUGIN_BASE_URL || (process.env.NODE_ENV === 'production' ? 'https://plugin.mintzy.in' : 'https://plugin.mintzy.in');
const PLUGIN_API_KEY = process.env.PLUGIN_API_KEY || 'changeme-plugin-api-key';

const API_KEY_VM_MAP = {
    '91IIRlrP': 'http://34.206.145.136:8000',
    '91IIRIrP': 'http://34.206.145.136:8000',
    '2pKOv1sa': 'http://44.208.177.169',
    'eyJhbGciOiJodHRwOi8vd3d3LnczLm9yZy8yMDAxLzA0L3htbGRzaWctbW9yZSNobWFjLXNoYTI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOiIxNzgyMzgzNjE5IiwiaXNzIjoibUFyS2V0SHVCIiwiZXhwIjoiMTgxMzc5NTIwMCIsImF1ZCI6IkhPOTk5OSIsImp0aSI6IjIwNyIsImZsZyI6IjY0In0.ueDks3vA9Jn8D1zBQwnnOlLoC9jQtsMIcXjPeNGwM0Q': 'http://32.198.166.49:8000'
};

const AUTO_AUTH_API_KEY_PREFIX = 'eyJhbGciOiJodHRwOi8vd3d3LnczLm9yZy8yMDAxLzA0L3htbGRzaWctbW9yZSNobWFjLXNoYTI1NiIsInR5cCI6IkpXVCJ9';

const normalizeApiKey = (apiKey) => String(apiKey || '').replace(/\s+/g, '');

const shouldAutoAuthenticateApiKey = (apiKey) => {
    const normalizedApiKey = normalizeApiKey(apiKey);
    return normalizedApiKey === AUTO_AUTH_API_KEY_PREFIX || normalizedApiKey.startsWith(`${AUTO_AUTH_API_KEY_PREFIX}.`);
};

const getTargetBaseUrlByApiKey = (apiKey) => {
    const normalizedApiKey = normalizeApiKey(apiKey);
    return API_KEY_VM_MAP[normalizedApiKey] || PLUGIN_BASE;
};

const parseResponseBody = async (response) => {
    const text = await response.text();

    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

/**
 * Low-level utility to forward requests to the FastAPI plugin
 */
async function forwardToPlugin(path, method = 'post', data = {}, headers = {}, params = {}, options = {}) {
    const base = options.targetBaseUrl || PLUGIN_BASE;
    const url = base.replace(/\/$/, '') + path;
    const h = { ...headers };

    console.log(`[Proxy] Forwarding ${method.toUpperCase()} request to exactly: ${url}`);
    
    if (PLUGIN_API_KEY && PLUGIN_API_KEY !== 'changeme-plugin-api-key') {
        h['X-Plugin-Api-Key'] = PLUGIN_API_KEY;
    }

    const timeoutMs = options.timeoutMs || parseInt(process.env.PLUGIN_REQUEST_TIMEOUT || '60000', 10);
    const maxRetries = (typeof options.retries === 'number') ? options.retries : parseInt(process.env.PLUGIN_REQUEST_RETRIES || '2', 10);
    const failOnError = options.failOnError === undefined ? true : !!options.failOnError;

    let lastErr = null;
    for (let attempt = 1; attempt <= Math.max(1, maxRetries); attempt++) {
        const start = Date.now();
        console.log("url",url);
        try {
            const opts = {
                method,
                headers: h,
                signal: AbortSignal.timeout(timeoutMs)
            };

            if (data !== null && data !== undefined && method.toLowerCase() !== "get") {
                opts.body = typeof data === "string" ? data : JSON.stringify(data);
                if (!opts.headers["Content-Type"] && !opts.headers["content-type"]) {
                    opts.headers["Content-Type"] = "application/json";
                }
            }

            const query = new URLSearchParams(params || {});
            const response = await fetch(query.size ? `${url}?${query.toString()}` : url, opts);
            const duration = Date.now() - start;
            const headers = Object.fromEntries(response.headers.entries());
            const responseType = options.responseType || "json";
            let responseData;

            if (responseType === "stream") {
                responseData = Readable.fromWeb(response.body);
            } else {
                responseData = await parseResponseBody(response);
            }

            const normalizedResponse = {
                status: response.status,
                headers,
                data: responseData
            };

            if (!response.ok) {
                const error = new Error(`Plugin returned status ${response.status}`);
                error.response = normalizedResponse;
                throw error;
            }

            logger.info(`[Proxy] ${method.toUpperCase()} ${path} success`, {
                duration,
                attempt,
                status: normalizedResponse.status
            });

            return normalizedResponse;
        } catch (err) {
            const duration = Date.now() - start;
            lastErr = err;

            logger.warn(`[Proxy] ${method.toUpperCase()} ${path} failed`, {
                url,
                duration,
                attempt,
                error: err.message,
                code: err.code,
                status: err.response?.status,
                stack: err.stack
            });

            const isClientError = err.response?.status >= 400 && err.response?.status < 500;

            if (attempt < maxRetries && !isClientError) {
                const backoff = 200 * attempt;
                await new Promise((r) => setTimeout(r, backoff));
                continue;
            }

            if (failOnError) {
                const customErr = new Error(`Plugin request failed at ${path}: ${err.message}`);
                customErr.status = err.response?.status || 502;
                customErr.statusCode = customErr.status;
                customErr.response = err.response;
                customErr.details = err.response?.data;
                throw customErr;
            }
            return null;
        }
    }
}

export {
    forwardToPlugin,
    PLUGIN_BASE,
    getTargetBaseUrlByApiKey,
    normalizeApiKey,
    shouldAutoAuthenticateApiKey
};

export default {
    forwardToPlugin,
    PLUGIN_BASE,
    getTargetBaseUrlByApiKey,
    normalizeApiKey,
    shouldAutoAuthenticateApiKey
};
