

import {Router} from "express";

import healthRoutes from "./routes/health.route.js";
import userRoutes from "./routes/user.route.js";
import authRoutes from "./routes/user.route.js";
import pluginRoutes from "./modules/angle_one/routes/plugin.routes.js";
import tradexRoutes from "./modules/tradex/routes/plugin.routes.js";
import bearStreetRoutes from "./modules/bear_street/routes/plugin.routes.js";

const router = Router();

router.use("/system" , healthRoutes);
router.use("/users", userRoutes);
router.use("/auth" , authRoutes);
router.use("/broker" , authRoutes);

router.use("/angle_one",pluginRoutes);
router.use("/tradex", tradexRoutes);
router.use("/bear_street", bearStreetRoutes);

export default router;



