import { getHealthStatus, getReadinessStatus } from "../services/health.service.js";


export const healthCheck = (req , res) =>{

    res.status(200).json(getHealthStatus())
}

export const readinessCheck = async (req , res) =>{

    const data = await getReadinessStatus();

    res.status(200).json(data);

}
