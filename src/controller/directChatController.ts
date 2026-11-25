// src/controllers/directChatController.ts
import TryCatch from "../config/TryCatch.js";
import type { authenticatedRequest } from "../middlewares/isAuth.js";
import { DirectChat, DirectChatStatus } from "../models/DirectChat.js";
import Message from "../models/Message.js";
import axios from "axios";
import mongoose from "mongoose";

const USER_SERVICE_URL = process.env.USERSERVICE || "http://localhost:5000";

export const createDirectChat = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { otherUserId } = req.body;

    if (!userId) return res.status(401).json({ message: "Please log in to create a chat" });
    if (!otherUserId) return res.status(400).json({ message: "Other user ID is required" });
    if (userId === otherUserId) return res.status(400).json({ message: "Cannot create chat with yourself" });
    if (!mongoose.Types.ObjectId.isValid(otherUserId)) return res.status(400).json({ message: "Invalid user ID format" });

    // Check if other user exists
    try {
        await axios.get(`${USER_SERVICE_URL}/api/v1/user/${otherUserId}`);
    } catch (error) {
        return res.status(404).json({ message: "User not found" });
    }

    // Check if active or pending chat already exists
    const existingChat = await DirectChat.findOne({
        participants: { $all: [userId, otherUserId] },
        status: { $in: [DirectChatStatus.ACTIVE, DirectChatStatus.PENDING] }
    });

    if (existingChat) return res.status(200).json({ message: "Chat already exists", chat: existingChat });

    // Create new chat with PENDING status
    const newChat = new DirectChat({
        participants: [userId, otherUserId],
        createdBy: userId,
        status: DirectChatStatus.PENDING
    });

    await newChat.save();

    res.status(201).json({
        message: "Chat request sent successfully",
        chat: newChat
    });
});

export const getDirectChats = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;

    if (!userId) return res.status(401).json({ message: "Please log in to view chats" });

    // Fetch active chats for the user and pending chats created by the user
    const directChats = await DirectChat.find({
        $or: [
            { participants: userId, status: DirectChatStatus.ACTIVE },
            { createdBy: userId, status: DirectChatStatus.PENDING }
        ]
    }).sort({ updatedAt: -1 });

    // Enrich direct chats with user data and unread status
    const enrichedChats = await Promise.all(
        directChats.map(async (chat) => {
            const otherUserId = chat.participants.find(
                id => id.toString() !== userId.toString()
            );

            // Get only the latest message for this user
            const latestMessage = await Message.findOne({
                directChatId: chat._id,
                senderId: { $ne: userId }
            }).sort({ createdAt: -1 }).select('_id seenBy');

            // Check if the user has seen the latest message
            const unread = latestMessage && !latestMessage.seenBy.includes(new mongoose.Types.ObjectId(userId)) ? true : false;

            // Fetch user data from user service
            let userData = null;
            if (otherUserId) {
                try { 
                    const response = await axios.get(
                        `${USER_SERVICE_URL}/api/v1/user/${otherUserId}`
                    );
                    userData = (response?.data as { user: any }).user;
                } catch (error) {
                    userData = {
                        _id: otherUserId,
                        name: "Unknown User",
                        username: "unknown",
                        avatar: null
                    };
                }
            }

            return {
                chatId: chat._id,
                status: chat.status,
                createdAt: chat.createdAt,
                updatedAt: chat.updatedAt,
                otherUser: userData,
                unread
            };
        })
    );

    res.status(200).json({
        message: "Chats fetched successfully",
        data: {
            chats: enrichedChats,
            totalCount: enrichedChats.length
        }
    });
});