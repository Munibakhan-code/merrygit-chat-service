// src/controllers/groupMemberController.ts
import TryCatch from "../config/TryCatch.js";
import type { authenticatedRequest } from "../middlewares/isAuth.js";
import { GroupChat, GroupChatRole, type IGroupMember } from "../models/GroupChat.js";
import axios from "axios";
import mongoose, { Types } from "mongoose";

const USER_SERVICE_URL = process.env.USERSERVICE || "http://localhost:5000";

// Add member to group (with pending status)
export const addMemberToGroup = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { groupId } = req.params;
    const { memberId } = req.body;

    if (!userId) return res.status(401).json({ message: "Please log in to add members" });
    if (!groupId || !mongoose.Types.ObjectId.isValid(groupId)) return res.status(400).json({ message: "Valid group ID is required" });
    if (!memberId || !mongoose.Types.ObjectId.isValid(memberId)) return res.status(400).json({ message: "Valid member ID is required" });
    if (userId.toString() === memberId.toString()) return res.status(400).json({ message: "Cannot add yourself as a member" });

    const group = await GroupChat.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    // Check if user is already a member
    const existingMember = group.members.find(m => m.user.toString() === memberId.toString());
    if (existingMember) {
        if (existingMember.status === 'pending') return res.status(409).json({ message: "Member invitation is already pending" });
        if (existingMember.status === 'accepted') return res.status(409).json({ message: "User is already a member of this group" });
        if (existingMember.status === 'declined') return res.status(409).json({ message: "User has previously declined invitation" });
    }

    // Check if requester has permission to add members
    const requesterMember = group.members.find(m => m.user.toString() === userId.toString());
    if (!requesterMember) return res.status(403).json({ message: "You are not a member of this group" });

    const canAddMembers =
        requesterMember.role === GroupChatRole.OWNER ||
        requesterMember.role === GroupChatRole.ADMIN ||
        group.settings.anyoneCanAddMembers;

    if (!canAddMembers) return res.status(403).json({ message: "You don't have permission to add members to this group" });

    // Check if user exists and is verified
    try {
        const response = await axios.get(`${USER_SERVICE_URL}/api/v1/user/${memberId}`);
        const user = (response?.data as { user?: { isVerified?: boolean } }).user;
        console.log("User data from user service:", user);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        if (!user.isVerified) {
            return res.status(403).json({ message: "User is not verified" });
        }
    } catch (error) {
        return res.status(404).json({ message: "User not found" });
    }

    // Add new member with pending status
    const newMember: IGroupMember = {
        user: new Types.ObjectId(memberId),
        role: GroupChatRole.MEMBER,
        joinedAt: new Date(),
        addedBy: new Types.ObjectId(userId),
        status: 'pending'
    };

    group.members.push(newMember);
    await group.save();

    res.status(201).json({
        message: "Member invitation sent successfully",
        member: {
            userId: memberId,
            role: GroupChatRole.MEMBER,
            status: 'pending',
            addedBy: userId,
            invitedAt: new Date()
        }
    });
});

// Remove member from group
export const removeMemberFromGroup = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { groupId, memberId } = req.params;

    if (!userId) return res.status(401).json({ message: "Please log in to remove members" });
    if (!groupId || !mongoose.Types.ObjectId.isValid(groupId)) return res.status(400).json({ message: "Valid group ID is required" });
    if (!memberId || !mongoose.Types.ObjectId.isValid(memberId)) return res.status(400).json({ message: "Valid member ID is required" });

    // Find the group
    const group = await GroupChat.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    // Check if target member exists in group
    const targetMemberIndex = group.members.findIndex(m => m.user.toString() === memberId.toString());
    if (targetMemberIndex === -1) return res.status(404).json({ message: "Member not found in group" });

    const targetMember = group.members[targetMemberIndex];
    if (!targetMember) return res.status(404).json({ message: "Member not found in group" });

    // Check if requester has permission to remove members
    const requesterMember = group.members.find(m => m.user.toString() === userId.toString());
    if (!requesterMember) return res.status(403).json({ message: "You are not a member of this group" });

    const isOwner = requesterMember.role === GroupChatRole.OWNER;
    const isAdmin = requesterMember.role === GroupChatRole.ADMIN;
    const isSelfRemoval = userId.toString() === memberId.toString();

    // Special case: Owner cannot be removed by anyone (including themselves)
    if (targetMember.role === GroupChatRole.OWNER) {
        // Check if owner is trying to leave the group (requires transfer ownership first)
        if (isSelfRemoval) return res.status(400).json({ message: "Group owner cannot leave the group. Transfer ownership first." });
        return res.status(403).json({ message: "Group owner cannot be removed" });
    }

    // Check permissions
    let canRemove = false;
    if (isOwner) {
        canRemove = true;
    } else if (isAdmin) {
        // Admin can remove members but not other admins
        canRemove = targetMember.role !== GroupChatRole.ADMIN;
    } else if (isSelfRemoval) {
        canRemove = true;
    }

    if (!canRemove) return res.status(403).json({ message: "You don't have permission to remove this member" });

    // Remove the member
    group.members.splice(targetMemberIndex, 1);

    // If group would have less than 2 members after removal, delete the group
    if (group.members.length < 2) {
        await GroupChat.findByIdAndDelete(groupId);
        return res.status(200).json({
            message: "Member removed. Group deleted as it would have less than 2 members."
        });
    }

    await group.save();

    res.status(200).json({
        message: "Member removed successfully",
        removedMemberId: memberId
    });
});

// Update member role (promote/demote)
export const updateMemberRole = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { groupId, memberId } = req.params;
    const { role } = req.body;

    if (!userId) return res.status(401).json({ message: "Please log in to update roles" });
    if (!groupId || !mongoose.Types.ObjectId.isValid(groupId)) return res.status(400).json({ message: "Valid group ID is required" });
    if (!memberId || !mongoose.Types.ObjectId.isValid(memberId)) return res.status(400).json({ message: "Valid member ID is required" });
    if (!role || !Object.values(GroupChatRole).includes(role)) return res.status(400).json({ message: "Valid role is required. Allowed roles: owner, admin, member" });

    // Find the group
    const group = await GroupChat.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    // Check if target member exists in group
    const targetMember = group.members.find(m => m.user.toString() === memberId.toString());
    if (!targetMember) return res.status(404).json({ message: "Member not found in group" });

    // Check if requester is the group owner
    const requesterMember = group.members.find(m => m.user.toString() === userId.toString());
    if (!requesterMember || requesterMember.role !== GroupChatRole.OWNER) return res.status(403).json({ message: "Only group owner can update member roles" });

    // Special handling for owner role changes
    if (role === GroupChatRole.OWNER) {
        // Find current owner(s)
        const currentOwner = group.members.find(m => m.role === GroupChatRole.OWNER);

        if (currentOwner) {
            // If transferring ownership to someone else
            if (currentOwner.user.toString() !== memberId.toString()) {
                // Demote current owner to admin
                currentOwner.role = GroupChatRole.ADMIN;
                // Promote target member to owner
                targetMember.role = GroupChatRole.OWNER;

                await group.save();

                return res.status(200).json({
                    message: "Ownership transferred successfully",
                    newOwner: {
                        userId: memberId,
                        name: "User details would be fetched from user service"
                    },
                    previousOwner: {
                        userId: currentOwner.user,
                        newRole: GroupChatRole.ADMIN
                    }
                });
            } else {
                // Trying to set current owner as owner again
                return res.status(400).json({ message: "User is already the group owner" });
            }
        }
    }

    // Prevent demoting the only owner
    if (targetMember.role === GroupChatRole.OWNER && role !== GroupChatRole.OWNER) {
        const ownerCount = group.members.filter(m => m.role === GroupChatRole.OWNER).length;
        if (ownerCount <= 1) {
            return res.status(400).json({
                message: "Cannot demote the only owner. Transfer ownership first."
            });
        }
    }

    // Update the role
    const previousRole = targetMember.role;
    targetMember.role = role;

    await group.save();

    res.status(200).json({
        message: "Member role updated successfully",
        member: {
            userId: memberId,
            previousRole,
            newRole: role
        }
    });
});

// Accept/Decline group invitation
export const respondToGroupInvitation = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { groupId } = req.params;
    const { action } = req.body; // 'accept' or 'decline'

    if (!userId) return res.status(401).json({ message: "Please log in to respond to invitation" });
    if (!groupId || !mongoose.Types.ObjectId.isValid(groupId)) return res.status(400).json({ message: "Valid group ID is required" });
    if (!action || !['accept', 'decline'].includes(action)) return res.status(400).json({ message: "Valid action is required: 'accept' or 'decline'" });

    // Find the group
    const group = await GroupChat.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    // Check if user has a pending invitation
    const userMember = group.members.find(m => m.user.toString() === userId.toString());
    if (!userMember) return res.status(404).json({ message: "No invitation found for you in this group" });

    if (userMember.status !== 'pending') return res.status(400).json({ message: `Your invitation is already ${userMember.status}` });

    // Update status based on action
    userMember.status = action === 'accept' ? 'accepted' : 'declined';

    if (action === 'accept') userMember.joinedAt = new Date();

    // If declined, remove from members array
    if (action === 'decline') {
        const memberIndex = group.members.findIndex(m => m.user.toString() === userId.toString());
        group.members.splice(memberIndex, 1);
    }

    // If group would have less than 2 members after declining, delete the group
    if (action === 'decline' && group.members.length < 2) {
        await GroupChat.findByIdAndDelete(groupId);
        return res.status(200).json({
            message: "Invitation declined. Group deleted as it would have less than 2 members."
        });
    }

    await group.save();

    res.status(200).json({
        message: action === 'accept' ? "Successfully joined the group" : "Invitation declined",
        status: userMember.status
    });
});

// Get group members with status
export const getGroupMembers = TryCatch(async (req: authenticatedRequest, res) => {
    const userId = req.user?._id;
    const { groupId } = req.params;

    if (!userId) return res.status(401).json({ message: "Please log in to view members" });
    if (!groupId || !mongoose.Types.ObjectId.isValid(groupId)) {
        return res.status(400).json({ message: "Valid group ID is required" });
    }

    // Find the group
    const group = await GroupChat.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found" });

    // Check if user is a member (with accepted status)
    const userMember = group.members.find(m =>
        m.user.toString() === userId.toString() && m.status === 'accepted'
    );

    if (!userMember) {
        // Check if user has pending invitation
        const pendingInvite = group.members.find(m =>
            m.user.toString() === userId.toString() && m.status === 'pending'
        );

        if (pendingInvite) {
            return res.status(403).json({
                message: "You have a pending invitation to this group"
            });
        }

        return res.status(403).json({ message: "You are not a member of this group" });
    }

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

    res.status(200).json({
        message: "Group members fetched successfully",
        members: enrichedMembers,
        totalCount: enrichedMembers.length,
        acceptedCount: enrichedMembers.filter(m => m.status === 'accepted').length,
        pendingCount: enrichedMembers.filter(m => m.status === 'pending').length
    });
});