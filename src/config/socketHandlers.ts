// src/config/sockethandlers.ts
import { Server, Socket } from "socket.io";
import { userSocketMap, userActiveChats, typingUsers } from "./socketState.js";
import type { TypingUser } from "./socketState.js";
import mongoose from "mongoose";
import Message, { MessageType, ChatType } from "../models/Message.js";
import { DirectChat, DirectChatStatus } from "../models/DirectChat.js";
import { GroupChat, GroupChatRole } from "../models/GroupChat.js";
import axios from "axios";

const USER_SERVICE_URL = process.env.USERSERVICE || "http://localhost:5000";

const fetchUserData = async (userId: string) => {
	try {
		const response = await axios.get(`${USER_SERVICE_URL}/api/v1/user/${userId}`);
		return (response?.data as { user: any }).user;
	} catch (error) {
		console.error(`Error fetching user ${userId}:`, error);
		return {
			_id: userId,
			name: "Unknown User",
			username: "unknown",
			avatar: null,
			isActive: false
		};
	}
};

export interface ClientToServerEvents {
	"message:send": (data: { chatId: string; message: unknown }) => void;
	"typing:start": (data: { chatId: string }) => void;
	"typing:stop": (data: { chatId: string }) => void;
	"chat:join": (data: { chatId: string }) => void;
	"chat:leave": (data: { chatId: string }) => void;
	"chat:viewing": (data: { chatId: string }) => void;
	"chat:not-viewing": (data: { chatId: string }) => void;
	"get:online-users": () => void;
	"get:viewing-users": () => void;
}

export interface ServerToClientEvents {
	"message:receive": (data: { chatId: string; message: unknown }) => void;
	"message:sent": (data: { chatId: string; message: unknown }) => void;
	"typing:start": (data: { chatId: string; userId: string }) => void;
	"typing:stop": (data: { chatId: string; userId: string }) => void;
	"user:online": (data: { userId: string }) => void;
	"user:offline": (data: { userId: string }) => void;
	"user:viewing": (data: { userId: string; chatId: string }) => void;
	"user:not-viewing": (data: { userId: string; chatId: string }) => void;
	"chat:updated": (data: { chatId: string }) => void;
	error: (data: { message: string }) => void;
}

// Handler registration
export const registerSocketHandlers = (io: Server, socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
	console.log("✅ A user connected: " + socket.id);
	console.log("Total connected clients:", io.engine.clientsCount);

	// Frontend sends userId via auth.token; fall back to query param for flexibility
	const authToken = socket.handshake.auth?.token;
	const rawUserId = authToken ?? socket.handshake.query.userId;
	const parsedUserId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
	const userId = typeof parsedUserId === "string" && parsedUserId.trim() !== "" && parsedUserId !== "undefined"
		? parsedUserId
		: null;
	
	if (userId) {
		userSocketMap[userId] = socket.id;
		console.log(`User ${userId} is online with socket ${socket.id}`);
		
		// Broadcast user:online event to all clients
		io.emit("user:online", { userId });

		// Send currently online users to the newly connected client
		Object.keys(userSocketMap).forEach(onlineUserId => {
			if (onlineUserId !== userId) {
				socket.emit("user:online", { userId: onlineUserId });
			}
		});

		// Send currently viewing users to the newly connected client
		Object.entries(userActiveChats).forEach(([viewingUserId, chatId]) => {
			if (viewingUserId !== userId && chatId) {
				socket.emit("user:viewing", { userId: viewingUserId, chatId });
			}
		});
	}

	// Event bindings
	socket.on("message:send", (data: { chatId: string; message: unknown }) => {
		handleSendMessage(io, socket, data, userId);
	});

	socket.on("typing:start", (data: { chatId: string }) => {
		handleTypingStart(io, socket, data, userId);
	});

	socket.on("typing:stop", (data: { chatId: string }) => {
		handleTypingStop(io, socket, data, userId);
	});

	socket.on("chat:join", (data: { chatId: string }) => {
		handleJoinChat(io, socket, data, userId);
	});

	socket.on("chat:leave", (data: { chatId: string }) => {
		handleLeaveChat(io, socket, data, userId);
	});

	socket.on("chat:viewing", (data: { chatId: string }) => {
		handleChatViewing(io, socket, data, userId);
	});

	socket.on("get:online-users", () => {
		// Re-send all currently online users to this specific socket
		Object.keys(userSocketMap).forEach(onlineUserId => {
			socket.emit("user:online", { userId: onlineUserId });
		});
		console.log(`Sent online users list to socket ${socket.id}`);
	});

	socket.on("get:viewing-users", () => {
		Object.entries(userActiveChats).forEach(([viewingUserId, chatId]) => {
			if (chatId) {
				socket.emit("user:viewing", { userId: viewingUserId, chatId });
			}
		});
		console.log(`Sent viewing users list to socket ${socket.id}`);
	});

	socket.on("chat:not-viewing", (data: { chatId: string }) => {
		handleChatNotViewing(io, socket, data, userId);
	});

	socket.on("disconnect", () => {
		handleDisconnect(io, socket, userId);
	});

	//	socket.on("connect_error", (err) => {
	// console.log(`Connection error: ${err.message}`);

	socket.on("error", (err: Error) => {
		console.log(`Socket error: ${err.message}`);
	});
};

// Individual handlers
export const handleSendMessage = async (
	io: Server,
	socket: Socket<ClientToServerEvents, ServerToClientEvents>,
	data: { chatId: string; message: unknown },
	socketUserId: string | null,
) => {
	const { chatId } = data;
	const message = (data.message || {}) as Record<string, any>;

	// Add temporary ID and timestamp if missing (client-side optimistic id)
	if (!message._id && !message.id) {
		message.id = "temp_" + Date.now() + "_" + Math.random().toString(36).substring(7);
	}
	message.createdAt = message.createdAt || new Date().toISOString();

	// Determine chat type (default to direct)
	const chatType = (message.chatType as string) === 'group' ? 'group' : 'direct';

	try {
		// Validate membership for direct/group chats before saving
		if (chatType === 'direct') {
			const directChat = await DirectChat.findById(chatId);
			if (!directChat) {
				socket.emit('error', { message: 'Direct chat not found' });
				return;
			}

			const userId = socketUserId;
			if (!userId) {
				socket.emit('error', { message: 'Not authenticated' });
				return;
			}

			const isParticipant = directChat.participants.some(p => p.toString() === userId.toString());
			if (!isParticipant) {
				socket.emit('error', { message: 'You are not part of this chat' });
				return;
			}

			if (directChat.status === DirectChatStatus.PENDING && directChat.createdBy.toString() !== userId.toString()) {
				socket.emit('error', { message: 'This chat is not active yet' });
				return;
			}

			// Create and persist message
			const newMessage = new Message({
				chatType: ChatType.DIRECT,
				senderId: userId,
				text: message.content || message.text || "",
				messageType: MessageType.TEXT,
				directChatId: chatId,
				seenBy: [userId],
			});

			await newMessage.save();
			await DirectChat.findByIdAndUpdate(chatId, { lastMessage: newMessage._id });

			// Enrich with sender data
			const sender = await fetchUserData(userId as string);
			const enriched = {
				...newMessage.toObject(),
				sender,
			};

			// Broadcast to others in the room
			socket.to(chatId).emit('message:receive', { chatId, message: enriched });

			// Optionally ack sender with definitive message (including _id)
			socket.emit('message:sent', { chatId, message: enriched });
			console.log(`[Socket Server] Saved + broadcast direct message in ${chatId}`);
			return;
		}

		// Group chat handling
		if (chatType === 'group') {
			const groupChat = await GroupChat.findById(chatId);
			if (!groupChat) {
				socket.emit('error', { message: 'Group chat not found' });
				return;
			}

			const userId = socketUserId;
			if (!userId) {
				socket.emit('error', { message: 'Not authenticated' });
				return;
			}

			const userMember = groupChat.members.find(m => m.user.toString() === userId.toString() && m.status === 'accepted');
			if (!userMember) {
				socket.emit('error', { message: 'You are not a member of this group' });
				return;
			}

			if (groupChat.settings.onlyAdminsCanSendMessages && userMember.role !== GroupChatRole.OWNER && userMember.role !== GroupChatRole.ADMIN) {
				socket.emit('error', { message: 'Only admins can send messages in this group' });
				return;
			}

			const newMessage = new Message({
				chatType: ChatType.GROUP,
				senderId: userId,
				text: message.content || message.text || "",
				messageType: MessageType.TEXT,
				groupChatId: chatId,
				seenBy: [userId],
			});

			await newMessage.save();
			await GroupChat.findByIdAndUpdate(chatId, { lastMessage: newMessage._id });

			const sender = await fetchUserData(userId as string);
			const enriched = {
				...newMessage.toObject(),
				sender,
			};

			socket.to(chatId).emit('message:receive', { chatId, message: enriched });
			socket.emit('message:sent', { chatId, message: enriched });
			console.log(`[Socket Server] Saved + broadcast group message in ${chatId}`);
			return;
		}
	} catch (err) {
		console.error('[Socket Server] Error handling message:send', err);
		socket.emit('error', { message: 'Failed to send message' });
	}
};

export const handleTypingStart = (io: Server, socket: Socket<ClientToServerEvents, ServerToClientEvents>, data: { chatId: string }, userId: string | null) => {
	const { chatId } = data;
	if (!userId) {
		return;
	}

	// Store typing user
	typingUsers[userId] = { roomId: chatId, userId, userName: userId } as TypingUser;

	// Notify others in the chat (except sender)
	socket.to(chatId).emit("typing:start", { 
		chatId, 
		userId
	});

	console.log(`User ${userId} started typing in chat ${chatId}`);
};

export const handleTypingStop = (io: Server, socket: Socket<ClientToServerEvents, ServerToClientEvents>, data: { chatId: string }, userId: string | null) => {
	const { chatId } = data;
	if (!userId) {
		return;
	}

	// Remove typing user
	delete typingUsers[userId];

	// Notify others in the chat (except sender)
	socket.to(chatId).emit("typing:stop", { 
		chatId, 
		userId
	});

	console.log(`User ${userId} stopped typing in chat ${chatId}`);
};

export const handleJoinChat = (io: Server, socket: Socket<ClientToServerEvents, ServerToClientEvents>, data: { chatId: string }, userId: string | null) => {
	const { chatId } = data;
	socket.join(chatId);

	if (userId) {
		userActiveChats[userId] = chatId;
	}

	console.log(`User ${userId ?? socket.id} joined chat ${chatId}`);
};

export const handleLeaveChat = (io: Server, socket: Socket<ClientToServerEvents, ServerToClientEvents>, data: { chatId: string }, userId: string | null) => {
	const { chatId } = data;
	socket.leave(chatId);

	if (userId && userActiveChats[userId] === chatId) {
		delete userActiveChats[userId];

		// Notify others that user stopped viewing this chat
		socket.to(chatId).emit("user:not-viewing", {
			userId,
			chatId,
		});
	}

	console.log(`User ${userId ?? socket.id} left chat ${chatId}`);
};


export const handleChatViewing = (io: Server, socket: Socket<ClientToServerEvents, ServerToClientEvents>, data: { chatId: string }, userId: string | null) => {
	const { chatId } = data;

	if (userId) {
		userActiveChats[userId] = chatId;

		// Broadcast that user is viewing this chat
		socket.to(chatId).emit("user:viewing", { 
			userId, 
			chatId
		});
	}

	console.log(`User ${userId ?? socket.id} is viewing chat ${chatId}`);
};

export const handleChatNotViewing = (io: Server, socket: Socket<ClientToServerEvents, ServerToClientEvents>, data: { chatId: string }, userId: string | null) => {
	const { chatId } = data;

	if (userId && userActiveChats[userId] === chatId) {
		delete userActiveChats[userId];

		// Broadcast that user stopped viewing this chat
		socket.to(chatId).emit("user:not-viewing", { 
			userId, 
			chatId
		});
	}

	console.log(`User ${userId ?? socket.id} stopped viewing chat ${chatId}`);
};

export const handleDisconnect = (io: Server, socket: Socket<ClientToServerEvents, ServerToClientEvents>, userId: string | null) => {
	console.log("❌ User disconnected: " + socket.id);

	if (userId) {
		// Clean up typing status
		Object.keys(typingUsers).forEach(key => {
			const tu = typingUsers[key];
			if (tu && tu.userId === userId) {
				const { roomId } = tu;
				socket.to(roomId).emit("typing:stop", { 
					chatId: roomId, 
					userId
				});
				delete typingUsers[key];
			}
		});

		// Check if user has other connected sockets
		let hasOtherSockets = false;
		let otherSocketId = null;

		for (const [id, s] of io.sockets.sockets.entries()) {
			if (id === socket.id) continue;
			
			const authToken = s.handshake.auth?.token;
			const rawUid = authToken ?? s.handshake.query.userId;
			const parsedUid = Array.isArray(rawUid) ? rawUid[0] : rawUid;
			
			if (parsedUid === userId) {
				hasOtherSockets = true;
				otherSocketId = id;
				break;
			}
		}

		if (hasOtherSockets && otherSocketId) {
			// Update userSocketMap to point to another active socket for this user
			userSocketMap[userId] = otherSocketId;
			console.log(`User ${userId} still online with socket ${otherSocketId}`);
		} else {
			// Get active chat before removing
			const activeChatId = userActiveChats[userId];

			// Notify all chats that user was viewing that they left
			if (activeChatId) {
				socket.to(activeChatId).emit("user:not-viewing", { 
					userId, 
					chatId: activeChatId
				});
			}

			// Remove from tracking completely
			if (userSocketMap[userId]) {
				delete userSocketMap[userId];
			}
			delete userActiveChats[userId];

			// Broadcast user:offline event to all clients
			io.emit("user:offline", { userId });

			console.log(`User ${userId} went offline`);
		}
	}

	console.log("Total connected clients:", io.engine.clientsCount);
};