import userModel from "../models/user.model.js";
import "../models/plan.js";
import userPlanModel from "../models/userPlan.js";
import generateApiKey from "../utils/generateApiKey.js";
import { createJwt, verifyJwt } from "../utils/jwt.js";

const createUserAuthToken = (user) => {
    return createJwt({
        userId: user._id.toString(),
        broker: user.broker,
        email: user.email,
        name: user.name
    });
};

const getBearerToken = (req) => {
    const authHeader = req.headers.authorization || "";

    return authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length).trim()
        : null;
};


export const getUser = async (req, res) => {
    try {
        const email = req.query.email || req.body.email;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email is required"
            });
        }

        const user = await userModel.findOne({ email }).lean();

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        return res.status(200).json({
            success: true,
            user
        });
    }catch(err){
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
}


export const updateBroker = async (req, res) => {
    try {
        const { userId, broker } = req.body;

        if (!userId || !broker) {
            return res.status(400).json({
                success: false,
                message: "Missing fields"
            });
        }

        const apiKey = generateApiKey();

        const user = await userModel.findByIdAndUpdate(
            userId,
            {
                broker,
                apiKey
            },
            {
                new: true
            }
        );
        console.log("Updated User:", user);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        res.json({
            success: true,
            apiKey,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                broker: user.broker
            }
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

export const onboard = async (req, res) => {
    try {
        const { apiKey } = req.body;

        if (!apiKey) {
            return res.status(400).json({
                success: false,
                message: "API Key is required"
            });
        }

        const user = await userModel.findOne({ apiKey }).lean();

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "Invalid API Key"
            });
        }

        const authToken = createUserAuthToken(user);

        res.json({
            success: true,
            jwt: authToken.token,
            expiresIn: authToken.expiresIn,
            expiresAt: authToken.expiresAt,
            broker: user.broker,
            user: {
                id: user._id,
                name: user.name,
                email: user.email
            }
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

export const getUserPlan = async (req, res) => {
    try {
        const apiKey = req.body.apiKey || req.query.apiKey;

        if (!apiKey) {
            return res.status(400).json({
                success: false,
                message: "API key is required"
            });
        }

        const user = await userModel.findOne({ apiKey }).lean();

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "Invalid API Key"
            });
        }

        const userPlan = await userPlanModel
            .findOne({
                userId: user._id,
                isActive: true
            })
            .sort({ createdAt: -1 })
            .populate("planId")
            .lean();

        if (!userPlan) {
            return res.status(404).json({
                success: false,
                message: "No active plan found for this user",
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email
                }
            });
        }

        return res.status(200).json({
            success: true,
            user: {
                id: user._id,
                name: user.name,
                email: user.email
            },
            plan: userPlan.planId,
            userPlan: {
                id: userPlan._id,
                creditsRemaining: userPlan.creditsRemaining,
                isActive: userPlan.isActive,
                expiresAt: userPlan.expiresAt,
                createdAt: userPlan.createdAt,
                updatedAt: userPlan.updatedAt
            }
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

export const refreshToken = async (req, res) => {
    try {
        const token = getBearerToken(req) || req.body.jwt || req.body.token;

        if (!token) {
            return res.status(400).json({
                success: false,
                message: "JWT token is required"
            });
        }

        const payload = verifyJwt(token);
        const user = await userModel.findById(payload.userId).lean();

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        const authToken = createUserAuthToken(user);

        return res.status(200).json({
            success: true,
            jwt: authToken.token,
            expiresIn: authToken.expiresIn,
            expiresAt: authToken.expiresAt,
            broker: user.broker,
            user: {
                id: user._id,
                name: user.name,
                email: user.email
            }
        });
    } catch (err) {
        return res.status(401).json({
            success: false,
            message: `Invalid JWT: ${err.message}`
        });
    }
};
