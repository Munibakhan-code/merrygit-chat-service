// src/index.ts
import dotenv from "dotenv";

import express from "express";
import connectDB from "./config/db.js";
import chatRoutes from "./route/chat.js";
import cors from "cors";
import cookieParser from "cookie-parser";
import { app, server } from "./config/socket.js";

dotenv.config();
connectDB();

// 🔐 REQUIRED FOR RENDER + SECURE COOKIES
app.set("trust proxy", 1);

// Middlewares
app.use(express.json());
app.use(cookieParser());

// ✅ CORRECT CORS
app.use(cors({
  origin: ["https://dev.merrygit.tech","https://www.merrygit.tech", "http://localhost:3000"],
  credentials: true,
}));

// Routes
app.use("/api/v1/chat", chatRoutes);

const PORT = process.env.PORT || 5002;

server.listen(PORT, () => {
  console.log(`🚀 Chat service running on port ${PORT}`);
});
