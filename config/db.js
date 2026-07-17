

export const connectDB = async() =>{
    if (!process.env.MONGO_URI) {
        console.warn("MONGO_URI is not configured; skipping database connection");
        return;
    }

    try{    
        const mongoose = await import('mongoose');

        await mongoose.connect(
            process.env.MONGO_URI 
        );

        console.log("Database Connected");

    }catch (error){
        console.error(error);
        process.exit(1);
    }
}
