// src/controllers/messageController.ts
import TryCatch from "../config/TryCatch.js";
import type { authenticatedRequest } from "../middlewares/isAuth.js";
import Message, { MessageType, ChatType } from "../models/Message.js";
import { DirectChat, DirectChatStatus } from "../models/DirectChat.js";
import { GroupChat, GroupChatRole } from "../models/GroupChat.js";
import mongoose from "mongoose";
import cloudinary from "../config/cloudinary.js";
import axios from "axios";

const USER_SERVICE_URL = process.env.USERSERVICE || "http://localhost:5000";

// Helper function to fetch user data from user service
const fetchUserData = async (userId: string) => {
    try {
        const response = await axios.get(`${USER_SERVICE_URL}/api/v1/user/${userId}`);

        return {
            _id: (response?.data as { user: any }).user._id,
            name: (response?.data as { user: any }).user.name,
            email: (response?.data as { user: any }).user.email,
            username: (response?.data as { user: any }).user.username,
            avatar: (response?.data as { user: any }).user.avatar ? (response?.data as { user: any }).user.avatar : null,
        };

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

// Helper function to enrich message with user data
const enrichMessageWithUserData = async (message: any) => {
    try {
        // Fetch sender data
        const senderData = await fetchUserData(message.senderId._id || message.senderId);

        // Fetch replyTo sender data if exists
        let replyToWithUser = null;
        if (message.replyTo && message.replyTo.senderId) {
            const replySenderData = await fetchUserData(message.replyTo.senderId._id || message.replyTo.senderId);
            replyToWithUser = {
                ...message.replyTo.toObject ? message.replyTo.toObject() : message.replyTo,
                sender: replySenderData
            };
        }

        return {
            ...message.toObject ? message.toObject() : message,
            sender: senderData,
            ...(replyToWithUser && { replyTo: replyToWithUser })
        };
    } catch (error) {
        console.error("Error enriching message:", error);
        return message;
    }
};

// Get messages for direct chat
// Get messages for direct chat
export const getDirectChatMessages = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { chatId } = req.params;

    if (!userId) return res.status(401).json({ message: "Please log in to view messages" });
    if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) return res.status(400).json({ message: "Valid chat ID is required" });

    // Get pagination parameters (cursor-based: before = createdAt of oldest loaded message)
    const limit = 10;
    const before = req.query.before as string | undefined; // ISO date string or undefined

    // Validate user access to direct chat
    const directChat = await DirectChat.findById(chatId);
    if (!directChat) return res.status(404).json({ message: "Direct chat not found" });

    // Check if user is a participant
    const isParticipant = directChat.participants.some(
        participant => participant.toString() === userId.toString()
    );
    if (!isParticipant) return res.status(403).json({ message: "You are not part of this chat" });

    // Block non-creators from viewing messages in pending chats
    if (directChat.status === DirectChatStatus.PENDING && directChat.createdBy.toString() !== userId.toString())
        return res.status(400).json({ message: "This chat is not active" });

    // Build query — if "before" cursor provided, fetch messages older than that timestamp
    const query: any = {
        isDeleted: false,
        directChatId: chatId,
        chatType: ChatType.DIRECT,
        ...(before && { createdAt: { $lt: new Date(before) } })
    };

    // Get total count and messages
    const [messages, totalCount] = await Promise.all([
        Message.find(query)
            .sort({ createdAt: -1 }) // newest first, then reverse below
            .limit(limit)
            .populate('replyTo', 'text messageType file image senderId') // add this
            .select("_id chatType directChatId senderId text messageType seenBy replyTo reactions createdAt"),

        Message.countDocuments({ isDeleted: false, directChatId: chatId, chatType: ChatType.DIRECT })
    ]);

    // Mark messages as seen by this user (except user's own messages)
    const messageIds = messages.map(msg => msg._id);
    await Message.updateMany(
        {
            _id: { $in: messageIds },
            senderId: { $ne: userId },
            seenBy: { $ne: userId }
        },
        { $addToSet: { seenBy: userId } }
    );

    // Fetch both participants' data once
    const otherUserId = directChat.participants.find(p => p.toString() !== userId.toString());
    const [selfData, otherUserData] = await Promise.all([
        fetchUserData(userId.toString()),
        otherUserId ? fetchUserData(otherUserId.toString()) : Promise.resolve(null)
    ]);

    // Build a sender map so we never fetch the same user twice
    const senderMap: Record<string, any> = {
        [userId.toString()]: selfData,
        ...(otherUserId && otherUserData ? { [otherUserId.toString()]: otherUserData } : {})
    };

    // Enrich messages using the pre-fetched sender map
    const enrichedMessages = await Promise.all(
        messages.map(async (message) => {
            const senderIdStr = message.senderId.toString();
            const sender = senderMap[senderIdStr] ?? await fetchUserData(senderIdStr); // fallback (edge case)

            let replyToWithUser = null;
            if (message.replyTo && (message.replyTo as any).senderId) {
                const replyTo = message.replyTo as any;
                const replySenderIdStr = (replyTo.senderId._id || replyTo.senderId).toString();
                const replySender = senderMap[replySenderIdStr] ?? await fetchUserData(replySenderIdStr);
                replyToWithUser = {
                    ...replyTo.toObject ? replyTo.toObject() : replyTo,
                    sender: replySender
                };
            }

            return {
                ...message.toObject(),
                sender,
                ...(replyToWithUser && { replyTo: replyToWithUser })
            };
        })
    );

    // Reverse to show oldest first for the UI
    const reversedMessages = enrichedMessages.reverse();

    // Cursor for the next "load more" call = createdAt of the oldest message in this batch
    const nextCursor = messages.length === limit
        ? messages[messages.length - 1].createdAt.toISOString()
        : null;

    res.status(200).json({
        message: "Messages fetched successfully",
        data: {
            messages: reversedMessages,
            chatType: 'direct',
            // Send participant data once at the top level
            participants: {
                self: selfData,
                other: otherUserData
            },
            pagination: {
                totalCount,
                limit,
                hasMore: nextCursor !== null,
                nextCursor  // pass this as ?before=<nextCursor> to load older messages
            }
        }
    });
});

// Get messages for group chat
// Get messages for group chat
export const getGroupChatMessages = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { chatId } = req.params;

    if (!userId) return res.status(401).json({ message: "Please log in to view messages" });
    if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) return res.status(400).json({ message: "Valid chat ID is required" });

    const limit = 10;
    const before = req.query.before as string | undefined;

    // Validate user access to group chat
    const groupChat = await GroupChat.findById(chatId);
    if (!groupChat) return res.status(404).json({ message: "Group chat not found" });

    // Check if user is a member with accepted status
    const userMember = groupChat.members.find(m =>
        m.user.toString() === userId.toString() && m.status === 'accepted'
    );
    if (!userMember) return res.status(403).json({ message: "You are not a member of this group" });

    // Build query with optional cursor
    const query: any = {
        isDeleted: false,
        groupChatId: chatId,
        chatType: ChatType.GROUP,
        ...(before && { createdAt: { $lt: new Date(before) } })
    };

    // Get messages and total count
    const [messages, totalCount] = await Promise.all([
        Message.find(query)
            .sort({ createdAt: -1 })
            .limit(limit)
            .populate('replyTo', 'text messageType file image senderId') // add this
            .select("_id chatType groupChatId senderId text messageType seenBy replyTo reactions createdAt"),

        Message.countDocuments({ isDeleted: false, groupChatId: chatId, chatType: ChatType.GROUP })
    ]);

    // Mark messages as seen by this user (except user's own messages)
    const messageIds = messages.map(msg => msg._id);
    await Message.updateMany(
        {
            _id: { $in: messageIds },
            senderId: { $ne: userId },
            seenBy: { $ne: userId }
        },
        { $addToSet: { seenBy: userId } }
    );

    // Collect all unique sender IDs from this batch (including replyTo senders)
    const senderIds = new Set<string>();
    messages.forEach(msg => {
        senderIds.add(msg.senderId.toString());
        const replyTo = msg.replyTo as any;
        if (replyTo?.senderId) {
            senderIds.add((replyTo.senderId._id || replyTo.senderId).toString());
        }
    });

    // Fetch all unique senders in parallel — one call per unique user, not per message
    const senderEntries = await Promise.all(
        Array.from(senderIds).map(async (id) => {
            const data = await fetchUserData(id);
            return [id, data] as [string, any];
        })
    );
    const senderMap = Object.fromEntries(senderEntries);

    // Enrich messages using the pre-fetched sender map
    const enrichedMessages = messages.map((message) => {
        const sender = senderMap[message.senderId.toString()];

        let replyToWithUser = null;
        const replyTo = message.replyTo as any;
        if (replyTo?.senderId) {
            const replySenderIdStr = (replyTo.senderId._id || replyTo.senderId).toString();
            replyToWithUser = {
                ...replyTo.toObject ? replyTo.toObject() : replyTo,
                sender: senderMap[replySenderIdStr]
            };
        }

        return {
            ...message.toObject(),
            sender,
            ...(replyToWithUser && { replyTo: replyToWithUser })
        };
    });

    // Reverse to show oldest first for the UI
    const reversedMessages = enrichedMessages.reverse();

    // Cursor for next "load more" = createdAt of the oldest message in this batch
    const nextCursor = messages.length === limit
        ? messages[messages.length - 1].createdAt.toISOString()
        : null;

    res.status(200).json({
        message: "Messages fetched successfully",
        data: {
            messages: reversedMessages,
            chatType: 'group',
            pagination: {
                totalCount,
                limit,
                hasMore: nextCursor !== null,
                nextCursor
            }
        }
    });
});

// Create a new message
export const createMessage = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { chatId, text, messageType, chatType, replyTo } = req.body;
    const file = req.file;

    if (!userId) return res.status(401).json({ message: "Please log in to send message" });
    if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) return res.status(400).json({ message: "Valid chat ID is required" });
    if (!chatType || !['direct', 'group'].includes(chatType)) return res.status(400).json({ message: "Valid chat type is required: 'direct' or 'group'" });

    if (chatType === 'direct') {
        const directChat = await DirectChat.findById(chatId);
        if (!directChat) return res.status(404).json({ message: "Direct chat not found" });

        const isParticipant = directChat.participants.some(participant => participant.toString() === userId.toString());
        if (!isParticipant) return res.status(403).json({ message: "You are not part of this chat" });
        // allow creater of the chat to send message even if it's not active (pending)
        // receiver have to accept the chat to send message, if the chat is pending and user is not the creator, they can't send message until the chat is accepted
        if (directChat.status === DirectChatStatus.PENDING && directChat.createdBy.toString() !== userId.toString()) { { message: "this chat is not active yet, accept the chat invitation to start messaging" } }

    } else {
        const groupChat = await GroupChat.findById(chatId);
        if (!groupChat) return res.status(404).json({ message: "Group chat not found" });

        // Check if user is a member with accepted status
        const userMember = groupChat.members.find(m =>
            m.user.toString() === userId.toString() && m.status === 'accepted'
        );
        if (!userMember) return res.status(403).json({ message: "You are not a member of this group" });

        // Check group settings for message permissions
        if (groupChat.settings.onlyAdminsCanSendMessages &&
            userMember.role !== GroupChatRole.OWNER &&
            userMember.role !== GroupChatRole.ADMIN) {
            return res.status(403).json({
                message: "Only admins can send messages in this group"
            });
        }
    }

    // Validate message content
    if (!text && !file && messageType !== MessageType.SYSTEM) {
        return res.status(400).json({ message: "Message text or file is required" });
    }

    // Check if replyTo message exists and belongs to same chat
    if (replyTo && mongoose.Types.ObjectId.isValid(replyTo)) {
        const repliedMessage = await Message.findById(replyTo);
        if (!repliedMessage) {
            return res.status(404).json({ message: "Replied message not found" });
        }

        // Check if replied message belongs to the same chat
        const repliedChatId = chatType === 'direct' ? repliedMessage.directChatId : repliedMessage.groupChatId;
        if (repliedChatId?.toString() !== chatId) {
            return res.status(400).json({ message: "Replied message does not belong to this chat" });
        }
    }

    let image = null;
    let fileData = null;

    // Handle file upload if present
    if (file) {
        try {
            const uploadResponse = await cloudinary.uploader.upload(file.path, {
                folder: "chat-media",
                resource_type: "auto"
            });

            if (file.mimetype.startsWith('image/')) {
                image = {
                    url: uploadResponse.secure_url,
                    publicId: uploadResponse.public_id
                };
            } else {
                fileData = {
                    url: uploadResponse.secure_url,
                    name: file.originalname,
                    size: file.size,
                    type: file.mimetype
                };
            }
        } catch (error) {
            console.error("Error uploading media:", error);
            return res.status(500).json({
                message: "Failed to upload media file"
            });
        }
    }

    // Determine message type
    let finalMessageType = messageType;
    if (!finalMessageType) {
        if (image) finalMessageType = MessageType.IMAGE;
        else if (fileData) finalMessageType = MessageType.FILE;
        else finalMessageType = MessageType.TEXT;
    }

    // Create message
    const newMessage = new Message({
        chatType: chatType === 'direct' ? ChatType.DIRECT : ChatType.GROUP,
        senderId: userId,
        text: text || (image ? "Sent an image" : fileData ? `Sent a file: ${fileData.name}` : ""),
        messageType: finalMessageType,
        ...(chatType === 'direct' ? { directChatId: chatId } : { groupChatId: chatId }),
        ...(image && { image }),
        ...(fileData && { file: fileData }),
        ...(replyTo && mongoose.Types.ObjectId.isValid(replyTo) && { replyTo }),
        seenBy: [userId] // Sender has seen their own message
    });

    await newMessage.save();

    // Update last message in chat
    if (chatType === 'direct') {
        await DirectChat.findByIdAndUpdate(chatId, { lastMessage: newMessage._id });
    } else {
        await GroupChat.findByIdAndUpdate(chatId, { lastMessage: newMessage._id });
    }

    // Populate replyTo field if it exists
    if (newMessage.replyTo) (await newMessage.populate('replyTo', 'text messageType file image'));

    // Enrich message with user data
    const enrichedMessage = await enrichMessageWithUserData(newMessage);

    res.status(201).json({
        message: "Message sent successfully",
        data: enrichedMessage
    });
});

// Delete a message (only sender can delete)
export const deleteMessage = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { messageId } = req.params;

    if (!userId) return res.status(401).json({ message: "Please log in to delete message" });
    if (!messageId || !mongoose.Types.ObjectId.isValid(messageId)) return res.status(400).json({ message: "Valid message ID is required" });
    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ message: "Message not found" });

    // Check if user is the sender
    if (message.senderId.toString() !== userId.toString()) return res.status(403).json({ message: "Only the sender can delete this message" });

    message.isDeleted = true;
    await message.save();

    res.status(200).json({
        message: "Message deleted successfully"
    });
});

// Search messages in a chat
// export const searchChatMessages = TryCatch(async (req: authenticatedRequest, res) => {
//     const userId = req.user?._id;
//     const { chatId } = req.params;
//     const { query, chatType } = req.query;

//     if (!userId) return res.status(401).json({ message: "Please log in to search messages" });
//     if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) return res.status(400).json({ message: "Valid chat ID is required" });
//     if (!chatType || !['direct', 'group'].includes(chatType as string)) return res.status(400).json({ message: "Valid chat type is required: 'direct' or 'group'" });
//     if (!query || query.toString().trim().length < 2) return res.status(400).json({ message: "Search query must be at least 2 characters long" });

//     // Validate user access to chat
//     if (chatType === 'direct') {
//         const directChat = await DirectChat.findById(chatId);
//         if (!directChat) return res.status(404).json({ message: "Direct chat not found" });

//         const isParticipant = directChat.participants.some(participant => participant.toString() === userId.toString());
//         if (!isParticipant) return res.status(403).json({ message: "You are not part of this chat" });

//     } else {

//         const groupChat = await GroupChat.findById(chatId);
//         if (!groupChat) return res.status(404).json({ message: "Group chat not found" });

//         const userMember = groupChat.members.find(m =>
//             m.user.toString() === userId.toString() && m.status === 'accepted'
//         );
//         if (!userMember) return res.status(403).json({ message: "You are not a member of this group" });
//     }

//     // Build search query
//     const searchQuery: any = {
//         isDeleted: false,
//         $text: { $search: query.toString() }
//     };

//     if (chatType === 'direct') {
//         searchQuery.directChatId = chatId;
//     } else {
//         searchQuery.groupChatId = chatId;
//     }


//     const messages = await Message.find(searchQuery)
//         .sort({ createdAt: -1 })
//         .limit(10);

//     // Enrich messages with user data
//     const enrichedMessages = await Promise.all(
//         messages.map(async (message) => { return await enrichMessageWithUserData(message) })
//     );

//     res.status(200).json({
//         message: "Search results fetched successfully",
//         data: {
//             messages: enrichedMessages,
//             totalCount: enrichedMessages.length,
//             query: query.toString()
//         }
//     });
// });