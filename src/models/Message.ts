// src/models/Message.ts (Unified for both Direct and Group chats)
import mongoose, { Schema, Document, Types } from "mongoose";

export enum MessageType {
    TEXT = 'text',
    IMAGE = 'image',
    FILE = 'file',
    SYSTEM = 'system'
}

export enum ChatType {
    DIRECT = 'direct',
    GROUP = 'group'
}

export interface IMessage extends Document {
    chatType: ChatType;
    directChatId?: Types.ObjectId;
    groupChatId?: Types.ObjectId;
    senderId: Types.ObjectId;
    text?: string;
    image?: {
        url: string;
        publicId: string;
    };
    file?: {
        url: string;
        name: string;
        size: number;
        type: string;
    };
    messageType: MessageType;
    seenBy: Types.ObjectId[];
    reactions: {
        userId: Types.ObjectId;
        emoji: string;
    }[];
    replyTo?: Types.ObjectId;
    isDeleted?: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const MessageSchema: Schema<IMessage> = new Schema({
    chatType: {
        type: String,
        enum: Object.values(ChatType),
        required: true
    },
    directChatId: {
        type: Schema.Types.ObjectId,
        ref: "DirectChat",
        index: true,
        sparse: true
    },
    groupChatId: {
        type: Schema.Types.ObjectId,
        ref: "GroupChat",
        index: true,
        sparse: true
    },
    senderId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    text: {
        type: String,
        trim: true,
        maxlength: 5000
    },
    image: {
        url: { type: String },
        publicId: { type: String }
    },
    file: {
        url: { type: String },
        name: { type: String },
        size: { type: Number },
        type: { type: String }
    },
    messageType: {
        type: String,
        enum: Object.values(MessageType),
        required: true,
        default: MessageType.TEXT
    },
    seenBy: [{
        type: Schema.Types.ObjectId,
        ref: "User",
        default: []
    }],
    reactions: [{
        userId: { type: Schema.Types.ObjectId, ref: "User" },
        emoji: { type: String }
    }],
    replyTo: {
        type: Schema.Types.ObjectId,
        ref: "Message",
        default: null
    },
    isDeleted: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true,
});

// Compound indexes for efficient queries
MessageSchema.index({ chatType: 1, createdAt: -1 });
MessageSchema.index({ senderId: 1, createdAt: -1 });
MessageSchema.index({ 'seenBy': 1 });
MessageSchema.index({ text: 'text' });

// Composite index for chat-specific queries
MessageSchema.index({ directChatId: 1, createdAt: -1 });
MessageSchema.index({ groupChatId: 1, createdAt: -1 });

// Pre-save validation to ensure only one chat reference exists
MessageSchema.pre('save', function (next) {
    const hasDirectChat = !!this.directChatId;
    const hasGroupChat = !!this.groupChatId;

    if ((hasDirectChat && hasGroupChat) || (!hasDirectChat && !hasGroupChat)) return next(new Error('Message must belong to either a DirectChat or GroupChat, but not both'));

    // Set chatType based on which reference exists
    this.chatType = hasDirectChat ? ChatType.DIRECT : ChatType.GROUP;
    next();
});

const Message = mongoose.model<IMessage>("Message", MessageSchema);
export default Message;