// src/controllers/groupChatController.ts
import TryCatch from "../config/TryCatch.js";
import type { authenticatedRequest } from "../middlewares/isAuth.js";
import { GroupChat, GroupChatRole } from "../models/GroupChat.js";
import Message from "../models/Message.js";
import axios from "axios";
import mongoose, { Types } from "mongoose";
import cloudinary from "../config/cloudinary.js";

const USER_SERVICE_URL = process.env.USERSERVICE || "http://localhost:5000";

export const createGroupChat = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { name, description, settings } = req.body;

    console.log("[createGroupChat] Request received", { userId, name });

    if (!userId) return res.status(401).json({ message: "Please log in to create a group" });
    if (!name || !name.trim()) return res.status(400).json({ message: "Group name is required" });
    if (name.length > 100) return res.status(400).json({ message: "Group name cannot exceed 100 characters" });
    if (name.length < 4) return res.status(400).json({ message: "Group name must be at least 4 characters long" });

    console.log("[createGroupChat] Validation passed, creating group");

    const creatorObjectId = new Types.ObjectId(userId);
    const ownerMember = {
        user: creatorObjectId,
        role: GroupChatRole.OWNER,
        joinedAt: new Date(),
        addedBy: creatorObjectId,
        status: 'accepted' as const
    };

    console.log("[createGroupChat] Creator assigned as owner", {
        userId: creatorObjectId.toString(),
        role: ownerMember.role
    });

    // Create group chat with only the creator as owner
    const newGroup = new GroupChat({
        name: name.trim(),
        description: description?.trim(),
        createdBy: creatorObjectId,
        members: [ownerMember],
        settings: {
            anyoneCanAddMembers: settings?.anyoneCanAddMembers ?? false,
            onlyAdminsCanSendMessages: settings?.onlyAdminsCanSendMessages ?? false,
            membersCanEditGroupInfo: settings?.membersCanEditGroupInfo ?? false
        }
    });

    console.log("[createGroupChat] Group object created, saving to database");
    await newGroup.save();
    console.log("[createGroupChat] Group saved successfully", { groupId: newGroup._id });

    res.status(201).json({
        message: "Group created successfully",
        group: {
            _id: newGroup._id,
            name: newGroup.name,
            description: newGroup.description,
            avatar: newGroup.avatar,
            memberCount: newGroup.members.length,
            createdAt: newGroup.createdAt,
            settings: newGroup.settings
        }
    });
});

export const getUserGroupChats = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;

    if (!userId) return res.status(401).json({ message: "Please log in to view groups" });

    // Get pagination parameters
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    if (page < 1 || limit < 1 || limit > 50) return res.status(400).json({ message: "Invalid pagination parameters" });

    // Fetch user's group chats with pagination
    const [groups, totalCount] = await Promise.all([
        GroupChat.find({
            'members.user': userId,
            'members.status': 'accepted' // Only show groups where user has accepted
        })
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(limit)
            .select('name description avatar members createdBy settings createdAt updatedAt'),

        GroupChat.countDocuments({
            'members.user': userId,
            'members.status': 'accepted'
        })
    ]);

    const enrichedGroups = await Promise.all(
        groups.map(async (group) => {
            console.log("[getUserGroupChats] Processing group", { groupId: group._id });

            // Get only the latest message for this user
            const latestMessage = await Message.findOne({
                groupChatId: group._id
            }).sort({ createdAt: -1 }).select('_id seenBy');

            // Check if the user has seen the latest message
            const unread = latestMessage ? !latestMessage.seenBy.some(id => id.toString() === userId.toString()) : false;

            console.log("[getUserGroupChats] Unread status", { groupId: group._id, unread, hasLatestMessage: !!latestMessage });

            // Get user's role in this group
            const userMember = group.members.find(m =>
                m.user.toString() === userId.toString() && m.status === 'accepted'
            );

            // Enrich member data with user service info
            const enrichedMembers = await Promise.all(
                group.members.map(async (member) => {
                    try {
                        const response = await axios.get(
                            `${USER_SERVICE_URL}/api/v1/user/${member.user}`
                        );
                        return {
                            user: (response?.data as { user: any }).user,
                            role: member.role,
                            joinedAt: member.joinedAt,
                            addedBy: member.addedBy,
                            status: member.status
                        };
                    } catch (error) {
                        return {
                            user: {
                                _id: member.user,
                                name: "Unknown User",
                                username: "unknown",
                                avatar: null
                            },
                            role: member.role,
                            joinedAt: member.joinedAt,
                            addedBy: member.addedBy,
                            status: member.status
                        };
                    }
                })
            );

            // Get member count
            const memberCount = group.members.length;

            return {
                _id: group._id,
                name: group.name,
                description: group.description,
                avatar: group.avatar,
                createdAt: group.createdAt,
                updatedAt: group.updatedAt,
                createdBy: group.createdBy,
                settings: group.settings,
                memberCount,
                members: enrichedMembers,
                userRole: userMember?.role,
                unread
            };
        })
    );

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    res.status(200).json({
        message: "Groups fetched successfully",
        data: {
            groups: enrichedGroups,
            pagination: {
                currentPage: page,
                totalPages,
                totalCount,
                itemsPerPage: limit,
                hasNextPage,
                hasPrevPage,
                nextPage: hasNextPage ? page + 1 : null,
                prevPage: hasPrevPage ? page - 1 : null
            }
        }
    });
});

// Update group chat (name, description, settings)
export const updateGroupChat = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { groupId } = req.params;
    const { name, description, settings } = req.body;

    if (!name || !settings) return res.status(400).json({ message: "All fields are required" });
    if (name.length > 100) return res.status(400).json({ message: "Group name cannot exceed 100 characters" });
    if (name.length < 4) return res.status(400).json({ message: "Group name must be at least 4 characters long" });
    if (!userId) return res.status(401).json({ message: "Please log in to update group" });
    if (!groupId || !mongoose.Types.ObjectId.isValid(groupId)) return res.status(400).json({ message: "Valid group ID is required" });

    const group = await GroupChat.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    const userMember = group.members.find(m => m.user.toString() === userId.toString());
    if (!userMember) return res.status(403).json({ message: "You are not a member of this group" });

    // Check permission: Only OWNER can update group info unless membersCanEditGroupInfo is true
    if (userMember.role !== GroupChatRole.OWNER) {
        if (!group.settings.membersCanEditGroupInfo) return res.status(403).json({ message: "Only group owner can update group information" });
    }

    // Update fields if provided
    if (name !== undefined) {
        if (!name.trim()) return res.status(400).json({ message: "Group name cannot be empty" });
        group.name = name.trim();
    }

    if (description !== undefined) group.description = description?.trim() || null;

    if (settings !== undefined) {
        // Only owner can update settings
        if (userMember.role !== GroupChatRole.OWNER) return res.status(403).json({ message: "Only group owner can update settings" });

        group.settings = {
            anyoneCanAddMembers: settings.anyoneCanAddMembers ?? group.settings.anyoneCanAddMembers,
            onlyAdminsCanSendMessages: settings.onlyAdminsCanSendMessages ?? group.settings.onlyAdminsCanSendMessages,
            membersCanEditGroupInfo: settings.membersCanEditGroupInfo ?? group.settings.membersCanEditGroupInfo
        };
    }

    const groupData = await group.save();

    res.status(200).json({
        message: "Group updated successfully",
        group: {
            _id: groupData._id,
            name: groupData.name,
            description: groupData.description,
            avatar: groupData.avatar,
            memberCount: groupData.members.length,
            createdAt: groupData.createdAt,
            updatedAt: groupData.updatedAt,
            settings: groupData.settings
        }
    });
});

// Upload group avatar
export const uploadGroupAvatar = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { groupId } = req.params;
    const imageFile = req.file;

    if (!userId) return res.status(401).json({ message: "Please log in to upload avatar" });
    if (!groupId || !mongoose.Types.ObjectId.isValid(groupId)) return res.status(400).json({ message: "Valid group ID is required" });
    if (!imageFile) return res.status(400).json({ message: "Avatar image is required" });

    const group = await GroupChat.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    // Check if user is a member and has permission
    const userMember = group.members.find(m => m.user.toString() === userId.toString());
    if (!userMember) return res.status(403).json({ message: "You are not a member of this group" });

    // Check permission: Only OWNER can upload avatar unless membersCanEditGroupInfo is true
    if (userMember.role !== GroupChatRole.OWNER) {
        if (!group.settings.membersCanEditGroupInfo) {
            return res.status(403).json({
                message: "Only group owner can upload group avatar"
            });
        }
    }

    try {
        // Delete old avatar from Cloudinary if exists
        // if (group.avatar) {
        //     console.log("Deleting old avatar from Cloudinary:", group.avatar);
        //     const publicId = group.avatar.split('/').pop()?.split('.')[0];
        //     if (publicId) {
        //         try {
        //             await cloudinary.uploader.destroy(`chat-images/${publicId}`);
        //             console.log("Old avatar deleted from Cloudinary:", group.avatar);
        //         } catch (error) {
        //             console.error("Error deleting old avatar from Cloudinary:", error);
        //         }
        //     }
        // }

        // Upload new avatar to Cloudinary
        const cloudinaryResponse = await cloudinary.uploader.upload(imageFile.path, {
            folder: "chat-images",
            // transformation: [{ width: 800, height: 800, crop: "limit" }]
        });

        // Update group avatar
        group.avatar = cloudinaryResponse.secure_url;
        const groupData = await group.save();

        res.status(200).json({
            message: "Group avatar uploaded successfully",
            group: {
                _id: groupData._id,
                name: groupData.name,
                description: groupData.description,
                avatar: groupData.avatar,
                memberCount: groupData.members.length,
                createdAt: groupData.createdAt,
                updatedAt: groupData.updatedAt,
                settings: groupData.settings
            }
        });
    } catch (error) {
        console.error("Error uploading group avatar:", error);
        res.status(500).json({
            message: "Failed to upload avatar : " + (error instanceof Error ? error.message : "Unknown error"),
        });
    }
});

// Delete group avatar
export const deleteGroupAvatar = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { groupId } = req.params;

    if (!userId) return res.status(401).json({ message: "Please log in to delete avatar" });
    if (!groupId || !mongoose.Types.ObjectId.isValid(groupId)) return res.status(400).json({ message: "Valid group ID is required" });

    // Find the group
    const group = await GroupChat.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    // Check if user is a member and has permission
    const userMember = group.members.find(m => m.user.toString() === userId.toString());
    if (!userMember) return res.status(403).json({ message: "You are not a member of this group" });

    // Check permission: Only OWNER can delete avatar unless membersCanEditGroupInfo is true
    if (userMember.role !== GroupChatRole.OWNER) {
        if (!group.settings.membersCanEditGroupInfo) {
            return res.status(403).json({
                message: "Only group owner can delete group avatar"
            });
        }
    }

    if (!group.avatar) return res.status(400).json({ message: "Group has no avatar to delete" });

    try {
        const publicId = group.avatar.split('/').pop()?.split('.')[0];
        // if (publicId) await cloudinary.uploader.destroy(`chat-images/${publicId}`);

        // Remove avatar URL from group
        group.avatar = "";
        const groupData = await group.save();

        res.status(200).json({
            message: "Group avatar deleted successfully",
            group: {
                _id: groupData._id,
                name: groupData.name,
                description: groupData.description,
                avatar: groupData.avatar,
                memberCount: groupData.members.length,
                createdAt: groupData.createdAt,
                updatedAt: groupData.updatedAt,
                settings: groupData.settings
            }
        });
    } catch (error) {
        console.error("Error deleting group avatar:", error);
        res.status(500).json({
            message: "Failed to delete group avatar : " + (error instanceof Error ? error.message : "Unknown error"),
        });
    }
});