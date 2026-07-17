const buckets = new Map();

const POINTS = 100;
const DURATION_MS = 60 * 1000;

const rateLimiter = {
    consume(key) {
        const now = Date.now();
        const bucket = buckets.get(key);

        if (!bucket || bucket.resetAt <= now) {
            buckets.set(key, {
                remaining: POINTS - 1,
                resetAt: now + DURATION_MS
            });
            return Promise.resolve();
        }

        if (bucket.remaining <= 0) {
            return Promise.reject(new Error("Rate limit exceeded"));
        }

        bucket.remaining -= 1;
        return Promise.resolve();
    }
};

export default rateLimiter;
