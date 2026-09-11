
import dotenv from 'dotenv';
import app from './app.js';
import { connectDB } from './config/db.js';
import { startSimulationJobPoller as startAngleOneSimulationJobPoller } from './modules/angle_one/services/plugin.simulation.service.js';
import { startSimulationJobPoller as startTradexSimulationJobPoller } from './modules/tradex/services/plugin.simulation.service.js';
import { startSimulationJobPoller as startBearStreetSimulationJobPoller } from './modules/bear_street/services/plugin.simulation.service.js';
import { startSimulationJobPoller as startFirstockSimulationJobPoller } from './modules/firstock/services/plugin.simulation.service.js';
import { startScheduledStartPoller } from './services/scheduledStart.service.js';
import { startDailyStatsScheduler } from './services/performance.service.js';

dotenv.config();

const PORT = process.env.PORT || 3000;

const startServer = async () => {
    await connectDB();
    startAngleOneSimulationJobPoller();
    startTradexSimulationJobPoller();
    startBearStreetSimulationJobPoller();
    startFirstockSimulationJobPoller();
    startScheduledStartPoller();
    startDailyStatsScheduler();

    app.listen(PORT ,()=>{
        console.log(`API Gateway listening on ${PORT}`)
    })
};

startServer();
