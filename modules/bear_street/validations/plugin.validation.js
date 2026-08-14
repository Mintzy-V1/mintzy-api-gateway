const validationError = (message) => ({
    details: [{ message }]
});

const createSchema = (validator) => ({
    validate(value = {}) {
        const result = validator(value || {});

        if (result.error) {
            return result;
        }

        return {
            error: null,
            value: result.value ?? value ?? {}
        };
    }
});

const requireString = (value, message) => {
    if (typeof value !== "string" || value.trim() === "") {
        return message;
    }

    return null;
};

const submitCredentialsSchema = createSchema((body) => {
    const errors = [
        requireString(body.userId, "User ID is required"),
        requireString(body.api_key, "API key is required"),
        requireString(body.client_code, "Client code is required"),
        requireString(body.password, "Password is required"),
        requireString(body.second_auth, "Second auth is required")
    ].filter(Boolean);

    if (body.source !== undefined && body.source !== null && typeof body.source !== "string") {
        errors.push("Source must be a string");
    }

    if (body.base_url !== undefined && body.base_url !== null && typeof body.base_url !== "string") {
        errors.push("Base URL must be a string");
    }

    if (errors.length > 0) {
        return { error: validationError(errors.join(", ")) };
    }

    return {
        value: {
            ...body,
            userId: body.userId.trim(),
            api_key: body.api_key.trim(),
            client_code: body.client_code.trim(),
            password: body.password.trim(),
            second_auth: body.second_auth.trim(),
            source: body.source?.trim() || "WEBAPI",
            base_url: body.base_url?.trim() || body.base_url,
            token: body.token
        }
    };
});

const startTradingSchema = createSchema((body) => {
    const sessionError = requireString(body.session_id, "Session ID is required");

    if (sessionError) {
        return { error: validationError(sessionError) };
    }

    return { value: body };
});

const passthroughSchema = createSchema((value) => ({ value }));

const tradingLogsQuerySchema = createSchema((query) => {
    const value = { ...query };

    if (value.limit !== undefined && value.limit !== null && value.limit !== "") {
        const parsed = Number(value.limit);
        if (!Number.isFinite(parsed)) {
            return { error: validationError("Limit must be a number") };
        }
        value.limit = parsed;
    }

    return { value };
});

const pluginValidation = {
    submitCredentialsSchema,
    startTradingSchema,
    sessionIdParamSchema: passthroughSchema,
    userIdParamSchema: passthroughSchema,
    tradingLogsQuerySchema
};

export default pluginValidation;
