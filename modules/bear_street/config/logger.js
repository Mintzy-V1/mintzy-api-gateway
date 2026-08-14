
const log = (level, message, meta) => {
    if (meta !== undefined) {
        console[level](message, meta);
        return;
    }
    console[level](message);
};

const logger = {
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
    debug: (message, meta) => log("debug", message, meta)
};

export default logger;
