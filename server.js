


import dotenv from 'dotenv';
import app from './app.js';
import { connectDB } from './config/db.js';

dotenv.config();

const PORT = process.env.PORT || 5000;

const startServer = async () => {
    await connectDB();

    app.listen(PORT ,()=>{
        console.log(`API Gateway listening on ${PORT}`)
    })
};

startServer();
