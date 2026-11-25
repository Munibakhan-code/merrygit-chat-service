// src/models/DirectChat.ts
import mongoose, { Document, Schema, Types } from 'mongoose';

export enum DirectChatStatus {
    PENDING = 'pending',
    ACTIVE = 'active',
    BLOCKED = 'blocked'
}

export interface IDirectChat extends Document {
    participants: Types.ObjectId[];
    createdBy: Types.ObjectId;
    status: DirectChatStatus;
    // lastMessage?: Types.ObjectId;
    blockedBy?: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const DirectChatSchema: Schema<IDirectChat> = new Schema(
    {
        participants: [{
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true
        }],
        createdBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        status: {
            type: String,
            enum: Object.values(DirectChatStatus),
            default: DirectChatStatus.ACTIVE
        },
        // lastMessage: {
        //     type: Schema.Types.ObjectId,
        //     ref: 'Message',
        //     default: null
        // },
        blockedBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            default: null
        }
    },
    {
        timestamps: true
    }
);

// Unique compound index for 1:1 chats (only one chat per pair of users)
DirectChatSchema.index({ participants: 1 }, { 
    unique: true,
    partialFilterExpression: { status: { $in: [DirectChatStatus.ACTIVE, DirectChatStatus.PENDING] } }
});

// Index for faster queries
DirectChatSchema.index({ createdBy: 1, status: 1 });
DirectChatSchema.index({ status: 1, updatedAt: -1 });
DirectChatSchema.index({ 'participants': 1, status: 1 });

// Pre-save middleware to ensure exactly 2 participants and sort them
DirectChatSchema.pre('save', function (next) {
    if (this.participants.length !== 2) {
        return next(new Error('Direct chat must have exactly 2 participants'));
    }
    
    // Sort participants for consistent unique indexing
    this.participants.sort((a, b) => a.toString().localeCompare(b.toString()));
    next();
});

export const DirectChat = mongoose.model<IDirectChat>('DirectChat', DirectChatSchema);