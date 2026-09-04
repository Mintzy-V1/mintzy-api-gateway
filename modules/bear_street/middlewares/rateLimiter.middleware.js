import rateLimiter from "../services/rateLimiter.service.js";

const rateLimiterMiddleware = async (req, res, next) => {
    try {
        await rateLimiter.consume(req.ip);
        next();
    } catch (error) {
        res.status(429).json({
            success: false,
            message: "Too many requests. Please try again later.",
        });
    }
};

export default rateLimiterMiddleware;
