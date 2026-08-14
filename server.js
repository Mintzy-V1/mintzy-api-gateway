
import dotenv from 'dotenv';
import app from './app.js';
import { connectDB } from './config/db.js';
import { startSimulationJobPoller } from './modules/angle_one/services/plugin.simulation.service.js';

dotenv.config();

const PORT = process.env.PORT || 3000;

const startServer = async () => {
    await connectDB();
    startSimulationJobPoller();

    app.listen(PORT ,()=>{
        console.log(`API Gateway listening on ${PORT}`)
    })
};

startServer();
