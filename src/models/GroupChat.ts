// src/models/GroupChat.ts
import mongoose, { Document, Schema, Types } from 'mongoose';

export enum GroupChatRole {
    OWNER = 'owner',
    ADMIN = 'admin',
    MEMBER = 'member'
}

export interface IGroupMember {
    user: Types.ObjectId;
    role: GroupChatRole;
    joinedAt: Date;
    addedBy?: Types.ObjectId;
    status?: 'accepted' | 'pending' | 'declined';
}

export interface IGroupChat extends Document {
    name: string;
    description?: string;
    avatar?: string;
    createdBy: Types.ObjectId;
    members: IGroupMember[];
    // lastMessage?: Types.ObjectId;
    settings: {
        anyoneCanAddMembers: boolean;
        onlyAdminsCanSendMessages: boolean;
        membersCanEditGroupInfo: boolean;
    };
    createdAt: Date;
    updatedAt: Date;
}

const GroupMemberSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    role: {
        type: String,
        enum: Object.values(GroupChatRole),
        default: GroupChatRole.MEMBER
    },
    joinedAt: {
        type: Date,
        default: Date.now
    },
    addedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User'
    },
    status: {
        type: String,
        enum: ['accepted', 'pending', 'declined'],
        default: 'pending'
    }
}, { _id: false });

const GroupChatSchema: Schema<IGroupChat> = new Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 100
        },
        description: {
            type: String,
            trim: true,
            maxlength: 500
        },
        avatar: {
            type: String,
            default: null
        },
        createdBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        members: [GroupMemberSchema],
        // lastMessage: {
        //     type: Schema.Types.ObjectId,
        //     ref: 'Message',
        //     default: null
        // },
        settings: {
            anyoneCanAddMembers: {
                type: Boolean,
                default: false
            },
            onlyAdminsCanSendMessages: {
                type: Boolean,
                default: false
            },
            membersCanEditGroupInfo: {
                type: Boolean,
                default: false
            }
        }
    },
    {
        timestamps: true
    }
);

// Indexes for efficient queries
GroupChatSchema.index({ 'members.user': 1, isActive: 1 });
GroupChatSchema.index({ createdBy: 1, isActive: 1 });
GroupChatSchema.index({ name: 'text', description: 'text' });
GroupChatSchema.index({ updatedAt: -1 });

// Pre-save middleware to ensure at least 1 member (the creator/owner)
GroupChatSchema.pre('save', function (next) {
    if (this.members.length < 1) {
        return next(new Error('Group chat must have at least 1 member'));
    }
    
    // Ensure at least one owner exists
    const hasOwner = this.members.some(m => m.role === GroupChatRole.OWNER);
    if (!hasOwner) {
        return next(new Error('Group chat must have at least one owner'));
    }
    
    next();
});

export const GroupChat = mongoose.model<IGroupChat>('GroupChat', GroupChatSchema);