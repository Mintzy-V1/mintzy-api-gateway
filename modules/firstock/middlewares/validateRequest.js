import AppError from "../utils/AppError.js";

const validateRequest = (schema, property = "body") => {
    return (req, res, next) => {
        const { error, value } = schema.validate(req[property], {
            abortEarly: false,
            stripUnknown: true
        });

        if (error) {
            return next(
                new AppError(
                    error.details.map((d) => d.message).join(", "),
                    400
                )
            );
        }

        if (property === "query" || property === "params") {
            Object.assign(req[property], value);
        } else {
            req[property] = value;
        }

        next();
    };
};

export default validateRequest;
