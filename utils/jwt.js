import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET || process.env.API_JWT_SECRET || "mintzy-dev-jwt-secret";
export const JWT_EXPIRES_IN_SECONDS = 24 * 60 * 60;

const base64UrlEncode = (value) => {
    const input = typeof value === "string" ? value : JSON.stringify(value);

    return Buffer.from(input)
        .toString("base64url");
};

const base64UrlDecode = (value) => {
    return Buffer.from(value, "base64url").toString("utf8");
};

const sign = (value) => {
    return crypto
        .createHmac("sha256", JWT_SECRET)
        .update(value)
        .digest("base64url");
};

export const createJwt = (payload, expiresInSeconds = JWT_EXPIRES_IN_SECONDS) => {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + expiresInSeconds;
    const header = {
        alg: "HS256",
        typ: "JWT"
    };
    const tokenPayload = {
        ...payload,
        iat: now,
        exp
    };

    const unsignedToken = `${base64UrlEncode(header)}.${base64UrlEncode(tokenPayload)}`;
    const token = `${unsignedToken}.${sign(unsignedToken)}`;

    return {
        token,
        expiresIn: expiresInSeconds,
        expiresAt: new Date(exp * 1000).toISOString()
    };
};

export const signJwt = (payload, expiresInSeconds = JWT_EXPIRES_IN_SECONDS) => {
    return createJwt(payload, expiresInSeconds).token;
};

export const verifyJwt = (token) => {
    if (!token) {
        throw new Error("Token is required");
    }

    const parts = token.split(".");

    if (parts.length !== 3) {
        throw new Error("Invalid token format");
    }

    const [encodedHeader, encodedPayload, signature] = parts;
    const unsignedToken = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = sign(unsignedToken);

    if (signature.length !== expectedSignature.length) {
        throw new Error("Invalid token signature");
    }

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        throw new Error("Invalid token signature");
    }

    const payload = JSON.parse(base64UrlDecode(encodedPayload));

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        throw new Error("Token expired");
    }

    return payload;
};
