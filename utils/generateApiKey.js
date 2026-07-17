import { randomBytes } from "crypto";

const generateApiKey = () => {
    return "mintzy_" + randomBytes(32).toString("hex");
};

export default generateApiKey;