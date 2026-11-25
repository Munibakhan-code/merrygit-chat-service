// src/route/chat.ts
import express from 'express';
import { isAuth } from '../middlewares/isAuth.js';
import { createDirectChat, getDirectChats } from '../controller/directChatController.js';
import { createGroupChat, getUserGroupChats, updateGroupChat, uploadGroupAvatar, deleteGroupAvatar } from '../controller/groupChatController.js';
import { upload } from '../middlewares/multer.js';
import { addMemberToGroup, getGroupMembers, removeMemberFromGroup, respondToGroupInvitation, updateMemberRole } from '../controller/groupMemberController.js';
import { respondToDirectChatRequest, getDirectChatRequests } from '../controller/directChatManagement.js'; // deleteChat
import {  createMessage, deleteMessage, getDirectChatMessages, getGroupChatMessages } from '../controller/messageController.js'; // searchChatMessages

const router = express.Router();

// Direct chat endpoints
router.post('/direct', isAuth, createDirectChat);
router.get('/direct', isAuth, getDirectChats);
router.get('/direct/requests', isAuth, getDirectChatRequests);
router.post('/direct/:chatId/invitation', isAuth, respondToDirectChatRequest);

// Group chat endpoints
router.post('/group', isAuth, createGroupChat);  // create group chat
router.get('/group', isAuth, getUserGroupChats);
router.put('/group/:groupId', isAuth, updateGroupChat);
router.post('/group/:groupId/avatar', isAuth, upload.single('avatar'), uploadGroupAvatar);
router.delete('/group/:groupId/avatar', isAuth, deleteGroupAvatar);

// Group member management endpoints
router.post('/group/:groupId/members', isAuth, addMemberToGroup);
router.delete('/group/:groupId/members/:memberId', isAuth, removeMemberFromGroup);
router.put('/group/:groupId/members/:memberId/role', isAuth, updateMemberRole);
router.post('/group/:groupId/invitation', isAuth, respondToGroupInvitation);
router.get('/group/:groupId/members', isAuth, getGroupMembers);

// Message endpoints
router.get('/direct/:chatId/messages', isAuth, getDirectChatMessages); // Get direct messages
        // /api/chat/direct/:chatId/messages?before=2026-05-13T06:27:46.285Z
router.get('/group/:chatId/messages', isAuth, getGroupChatMessages); // Get group messages
router.post('/messages', isAuth, upload.single('file'), createMessage); // Create message
router.delete('/messages/:messageId', isAuth, deleteMessage); // Delete message (sender only)
// router.get('/:chatType/:chatId/messages/search', isAuth, searchChatMessages); // Search messages

// Chat deletion endpoint (works for both direct and group)
// router.delete('/:chatType/:chatId', isAuth, deleteChat); 

export default router;