import cors from "cors"

const corsMiddleware = cors({

    // Echo the request origin instead of "*" — wildcard + credentials is
    // rejected by browsers, which broke desktop-app requests (file:// origin).
    origin: (origin, callback) => callback(null, origin || "*"),
    credentials: true,
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