// src/controllers/directChatManagement.ts
import TryCatch from "../config/TryCatch.js";
import type { authenticatedRequest } from "../middlewares/isAuth.js";
import { DirectChat, DirectChatStatus } from "../models/DirectChat.js";
import Message, { ChatType } from "../models/Message.js";
import mongoose, { Types } from "mongoose"; // Import Types from mongoose
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

export const respondToDirectChatRequest = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { chatId } = req.params;
    const { action } = req.body; // 'accept' or 'reject'

    if (!userId) return res.status(401).json({ message: "Please log in to respond to chat request" });
    if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) return res.status(400).json({ message: "Valid chat ID is required" });
    if (!action || !['accept', 'reject'].includes(action)) return res.status(400).json({ message: "Valid action is required: 'accept' or 'reject'" })

    const directChat = await DirectChat.findById(chatId);
    if (!directChat) return res.status(404).json({ message: "Chat not found" });

    const isParticipant = directChat.participants.some(
        participant => participant.toString() === userId.toString()
    );
    if (!isParticipant) return res.status(403).json({ message: "You are not part of this chat" });
    if (directChat.createdBy.toString() === userId.toString()) return res.status(400).json({ message: "You cannot accept/reject your own chat request" });
    if (directChat.status !== DirectChatStatus.PENDING) return res.status(400).json({ message: `Chat is already ${directChat.status.toLowerCase()}` });

    if (action === 'accept') {
        directChat.status = DirectChatStatus.ACTIVE;
        await directChat.save();

        const otherUserId = directChat.participants.find(
            id => id.toString() !== userId.toString()
        );
        let otherUserData = null;

        if (otherUserId) {
            otherUserData = await fetchUserData(otherUserId.toString());
        }

        res.status(200).json({
            message: "Chat request accepted successfully",
            chat: {
                _id: directChat._id,
                participants: directChat.participants,
                status: directChat.status,
                createdAt: directChat.createdAt,
                updatedAt: directChat.updatedAt,
                otherUser: otherUserData
            }
        });
    } else { // reject
        directChat.status = DirectChatStatus.BLOCKED;
        directChat.blockedBy = new Types.ObjectId(userId);
        await directChat.save();

        res.status(200).json({
            message: "Chat request rejected successfully",
            chat: {
                _id: directChat._id,
                status: directChat.status,
                updatedAt: directChat.updatedAt
            }
        });
    }
});

export const getDirectChatRequests = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;

    if (!userId) return res.status(401).json({ message: "Please log in to view chat requests" });

    try {
        const pendingChats = await DirectChat.find({
            participants: userId,
            status: DirectChatStatus.PENDING,
            createdBy: { $ne: new Types.ObjectId(userId) }
        }).sort({ createdAt: -1 });

        const totalCount = pendingChats.length;

        const enrichedRequests = await Promise.all(
            pendingChats.map(async (chat) => {
                // Get sender data from user service
                let senderData = null;
                try {
                    const response = await axios.get(`${USER_SERVICE_URL}/api/v1/user/${chat.createdBy}`);
                    senderData = (response?.data as { user: any }).user;
                } catch (error) {
                    senderData = {
                        _id: chat.createdBy,
                        name: "Unknown User",
                        username: "unknown",
                        avatar: null,
                        isActive: false
                    };
                }

                return {
                    _id: chat._id,
                    sender: senderData,
                    createdAt: chat.createdAt,
                };
            })
        );

        res.status(200).json({
            message: "Pending chat requests fetched successfully",
            data: {
                requests: enrichedRequests,
                totalCount
            }
        });

    } catch (error) {
        console.error("Error fetching direct chat requests:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// export const deleteChat = TryCatch(async (req: authenticatedRequest, res) => {
//     const userId = req.user?._id;
//     const { chatId } = req.params;
//     const { chatType } = req.body; // 'direct' or 'group'

//     if (!userId) return res.status(401).json({ message: "Please log in to delete chat" });
//     if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) {
//         return res.status(400).json({ message: "Valid chat ID is required" });
//     }
//     if (!chatType || !['direct', 'group'].includes(chatType)) {
//         return res.status(400).json({ message: "Valid chat type is required: 'direct' or 'group'" });
//     }

//     if (chatType === 'direct') {
//         // For direct chat
//         const directChat = await DirectChat.findById(chatId);
//         if (!directChat) return res.status(404).json({ message: "Direct chat not found" });

//         // Check if user is a participant
//         const isParticipant = directChat.participants.some(
//             participant => participant.toString() === userId.toString()
//         );
//         if (!isParticipant) return res.status(403).json({ message: "You are not part of this chat" });

//         // Mark all messages in this direct chat as deleted
//         await Message.updateMany(
//             {
//                 directChatId: chatId
//             },
//             {
//                 $set: { isDeleted: true }
//             }
//         );

//         // Update chat status to blocked (soft delete)
//         directChat.status = DirectChatStatus.BLOCKED;
//         directChat.blockedBy = new Types.ObjectId(userId); // Convert to ObjectId
//         await directChat.save();

//         res.status(200).json({
//             message: "Chat deleted successfully. All messages marked as deleted.",
//             chatType: 'direct',
//             chatId
//         });

//     } else {
//         // For group chat - check membership first
//         const GroupChat = (await import('../models/GroupChat.js')).GroupChat;
//         const groupChat = await GroupChat.findById(chatId);
//         if (!groupChat) return res.status(404).json({ message: "Group chat not found" });

//         // Check if user is a member
//         const userMember = groupChat.members.find(m =>
//             m.user.toString() === userId.toString() && m.status === 'accepted'
//         );
//         if (!userMember) return res.status(403).json({ message: "You are not a member of this group" });

//         // Mark group messages as deleted for this user
//         await Message.updateMany(
//             { groupChatId: chatId }, { $set: { isDeleted: true } }
//         );

//         res.status(200).json({
//             message: "Group chat messages marked as deleted.",
//             chatType: 'group',
//             chatId
//         });
//     }
// });

