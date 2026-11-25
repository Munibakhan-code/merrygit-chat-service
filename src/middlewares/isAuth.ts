// src/middleware/isAuth.ts
import type { Request } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";

interface IUser {
    _id: string;
    email: string;
    name: string;
    username: string;
    phoneNumber?: string;
    avatar?: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface authenticatedRequest extends Request {
    user?: IUser | null;
}

export const isAuth = async (req: authenticatedRequest, res: any, next: any) => {
    try {
        const authToken = req.cookies?.token;
        if (!authToken) return res.status(401).json({ message: "Unauthorized - No token provided" });
        const decodedValue = jwt.verify(authToken, process.env.JWT_SECRET as string) as JwtPayload;
        if (!decodedValue) return res.status(401).json({ message: "Unauthorized - Invalid token" });

        const user = decodedValue?.user;
        if (!user) return res.status(401).json({ message: "Unauthorized user" });

        req.user = user;
        next();
    } catch (error) {
        res.status(401).json({ message: "Unauthorized - jwt verification failed", error: (error as Error).message });
    }
}