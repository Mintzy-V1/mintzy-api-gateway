import { createJwt, verifyJwt } from "../../../utils/jwt.js";

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length).trim()
        : null;

    if (token) {
        try {
            const payload = verifyJwt(token);

            req.user = {
                userId: payload.userId,
                id: payload.userId,
                email: payload.email,
                name: payload.name,
                broker: payload.broker
            };
            req.broker = payload.broker;
            req.auth = payload;

            const refreshedAuth = createJwt({
                userId: payload.userId,
                broker: payload.broker,
                email: payload.email,
                name: payload.name
            });

            res.setHeader("X-Refreshed-JWT", refreshedAuth.token);
            res.setHeader("X-JWT-Expires-In", String(refreshedAuth.expiresIn));
            res.setHeader("X-JWT-Expires-At", refreshedAuth.expiresAt);

            return next();
        } catch (err) {
            return res.status(401).json({
                success: false,
                message: `Invalid JWT: ${err.message}`
            });
        }
    }

    const userId =
        req.headers["x-user-id"] ||
        req.headers["x-forwarded-user"] ||
        req.body?.userId ||
        req.query?.userId;

    if (userId && !req.user) {
        req.user = { userId };
        return next();
    }

    return res.status(401).json({
        success: false,
        message: "JWT token is required"
    });
};

export default authMiddleware;
