// src/config/socketState.ts
export type TypingUser = {
	roomId: string;
	userId: string;
	userName: string;
};

export const userSocketMap: Record<string, string> = {};
export const userActiveChats: Record<string, string> = {};
export const typingUsers: Record<string, TypingUser> = {};
