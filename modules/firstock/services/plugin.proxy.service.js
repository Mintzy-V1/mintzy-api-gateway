import { Readable } from "stream";
import logger from "../config/logger.js";
import AppError from "../utils/AppError.js";

const PLUGIN_BASE = process.env.FIRSTOCK_PLUGIN_BASE_URL
    || process.env.PLUGIN_BASE_URL
    || "http://34.205.29.123:8000";
const PLUGIN_API_KEY = process.env.PLUGIN_API_KEY || "changeme-plugin-api-key";

const resolvePluginTargetUrl = (tradingSession) => tradingSession?.vm_url || PLUGIN_BASE;

const parseResponseBody = async (response) => {
    const text = await response.text();

    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

const parsePluginTarget = (url) => {
    try {
        const parsed = new URL(url);
        return {
            hostname: parsed.hostname || null,
            port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
            protocol: parsed.protocol || null
        };
    } catch {
        return { hostname: null, port: null, protocol: null };
    }
};

const getFetchFailureDetails = (err) => ({
    causeCode: err.cause?.code || err.code || null,
    causeErrno: err.cause?.errno || null,
    causeSyscall: err.cause?.syscall || null,
    causeAddress: err.cause?.address || null,
    causePort: err.cause?.port || null,
    causeMessage: err.cause?.message || null,
    causeName: err.cause?.name || null,
    errorName: err.name || null,
    errorMessage: err.message || null
});

const shouldStopDiag = (path, options) =>
    String(path || "").includes("stop-simulation") || options?.failOnError === false;

async function forwardToPlugin(path, method = "post", data = {}, headers = {}, params = {}, options = {}) {
    const base = options.targetBaseUrl || PLUGIN_BASE;
    const url = base.replace(/\/$/, "") + path;
    const h = { ...headers };

    if (PLUGIN_API_KEY && PLUGIN_API_KEY !== "changeme-plugin-api-key") {
        h["X-Plugin-Api-Key"] = PLUGIN_API_KEY;
    }

    const timeoutMs = options.timeoutMs || parseInt(process.env.PLUGIN_REQUEST_TIMEOUT || "60000", 10);
    const maxRetries = typeof options.retries === "number"
        ? options.retries
        : parseInt(process.env.PLUGIN_REQUEST_RETRIES || "2", 10);
    const failOnError = options.failOnError === undefined ? true : !!options.failOnError;

    for (let attempt = 1; attempt <= Math.max(1, maxRetries); attempt += 1) {
        const start = Date.now();

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
            const headersObject = Object.fromEntries(response.headers.entries());
            const responseType = options.responseType || "json";
            const responseData = responseType === "stream"
                ? Readable.fromWeb(response.body)
                : await parseResponseBody(response);

            const normalizedResponse = {
                status: response.status,
                headers: headersObject,
                data: responseData
            };

            if (!response.ok) {
                const error = new Error(`Plugin returned status ${response.status}`);
                error.response = normalizedResponse;
                throw error;
            }

            const durationMs = Date.now() - start;
            logger.info(`[Firstock Proxy] ${method.toUpperCase()} ${path} success`, {
                duration: durationMs,
                attempt,
                status: normalizedResponse.status
            });
            if (shouldStopDiag(path, options)) {
                logger.info("[STOP-DIAG] plugin request ok", {
                    method: method.toUpperCase(),
                    path,
                    url,
                    ...parsePluginTarget(url),
                    attempt,
                    maxRetries,
                    timeoutMs,
                    durationMs,
                    status: normalizedResponse.status
                });
            }

            return normalizedResponse;
        } catch (err) {
            const isClientError = err.response?.status >= 400 && err.response?.status < 500;
            const durationMs = Date.now() - start;
            const fetchFailure = getFetchFailureDetails(err);
            const target = parsePluginTarget(url);
            const willRetry = attempt < maxRetries && !isClientError;

            logger.warn(`[Firstock Proxy] ${method.toUpperCase()} ${path} failed`, {
                url,
                duration: durationMs,
                attempt,
                timeoutMs,
                maxRetries,
                error: err.message,
                status: err.response?.status,
                details: err.response?.data,
                fetchFailure
            });
            if (shouldStopDiag(path, options)) {
                logger.warn("[STOP-DIAG] plugin request failed", {
                    method: method.toUpperCase(),
                    path,
                    url,
                    ...target,
                    attempt,
                    maxRetries,
                    timeoutMs,
                    durationMs,
                    failOnError,
                    willRetry,
                    status: err.response?.status || null,
                    ...fetchFailure
                });
            }

            if (willRetry) {
                await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
                continue;
            }

            if (failOnError) {
                const statusCode = err.response?.status || 502;
                const customErr = new AppError(`Plugin request failed at ${path}: ${err.message}`, statusCode);
                customErr.response = err.response;
                customErr.details = {
                    targetUrl: url,
                    timeoutMs,
                    attempt,
                    maxRetries,
                    durationMs,
                    ...target,
                    ...fetchFailure,
                    pluginBody: err.response?.data ?? null
                };
                throw customErr;
            }

            return null;
        }
    }

    return null;
}

export {
    forwardToPlugin,
    PLUGIN_BASE,
    resolvePluginTargetUrl
};

export default {
    forwardToPlugin,
    PLUGIN_BASE,
    resolvePluginTargetUrl
};
