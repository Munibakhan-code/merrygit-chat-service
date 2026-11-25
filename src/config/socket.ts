// src/config/socket.ts
import { Server } from "socket.io";
import http from "http";
import express from "express";
import { registerSocketHandlers, ClientToServerEvents, ServerToClientEvents } from "./socketHandlers.js";
import { userSocketMap } from "./socketState.js";

const app = express();
const server = http.createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"],
	},
});

console.log("Socket.io server initialized and waiting for connections...");

io.on("connection", (socket) => {
	registerSocketHandlers(io, socket);
});

export { server, app, io, userSocketMap };