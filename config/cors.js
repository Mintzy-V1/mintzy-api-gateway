
import cors from "cors"

const corsMiddleware = cors({

    origin:"*",
    credentials:true,
    methods:[
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE"
    ],

    allowedHeaders:[
        "content-type",
        "Authorization"
    ],

    exposedHeaders:[
        "X-Refreshed-JWT",
        "X-JWT-Expires-In",
        "X-JWT-Expires-At"
    ]
});

export default corsMiddleware;
