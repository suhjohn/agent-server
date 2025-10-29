import { db } from "./connection";
import { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  sessions,
  messages,
  type Session,
  type Message,
  type NewSession,
  type NewMessage,
} from "./schema";
import { eq, desc, ne, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import { findCodexSessionFileById } from "@/services/codex";

/**
 * Get an existing session by ID
 */
export async function getSession(sessionId: string): Promise<Session | null> {
  try {
    const result = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    return result[0] || null;
  } catch (error) {
    console.error("Error getting session:", error);
    throw new Error("Failed to retrieve session");
  }
}

/**
 * Create a new session
 */
export async function createSession({
  sessionId,
  agent = "claude-code",
  cwd,
  model,
}: {
  sessionId: string;
  agent?: "claude-code" | "codex" | undefined;
  cwd: string;
  model?: string | undefined;
}): Promise<Session> {
  try {
    const newSession: NewSession = {
      id: sessionId,
      name: "",
      agent,
      cwd,
      model,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.insert(sessions).values(newSession).returning();

    if (!result[0]) {
      throw new Error("Failed to create session - no result returned");
    }

    return result[0];
  } catch (error) {
    console.error("Error creating session:", error);
    throw new Error("Failed to create session");
  }
}

/**
 * Get messages for a session, ordered by creation time
 */
export async function getMessages(sessionId: string) {
  try {
    const session = await getSession(sessionId);
    if (session?.agent === "codex") {
      if (!session.internalSessionId) {
        return [];
      }
      const filePath = await findCodexSessionFileById(
        session.internalSessionId
      );
      if (!filePath) {
        return [];
      }
      // read from the internalSessionId file which will be jsonl
      const file = await fs.readFile(filePath, "utf8");
      const messages = file
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line, index) => {
          try {
            return JSON.parse(line);
          } catch (e) {
            console.warn(
              `Skipping invalid JSONL line ${index} in ${filePath}:`,
              e
            );
            return null;
          }
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return messages;
    }
    const result = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.createdAt);

    const flatlistContents = result.flatMap((message) => message.contents);
    return flatlistContents;
  } catch (error) {
    console.error("Error getting messages:", error);
    throw new Error("Failed to retrieve messages");
  }
}

/**
 * Create a new message record
 */
export async function createMessage(
  sessionId: string,
  messageId: string,
  message: SDKMessage
): Promise<Message> {
  try {
    const newMessage: NewMessage = {
      sessionId,
      messageId,
      role: message.type,
      contents: [message],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.insert(messages).values(newMessage).returning();

    if (!result[0]) {
      throw new Error("Failed to create message - no result returned");
    }

    return result[0];
  } catch (error) {
    console.error("Error creating message:", error);
    throw new Error("Failed to create message");
  }
}

export async function updateInternalSessionId(
  sessionId: string,
  internalSessionId: string
): Promise<Session | null> {
  const updated = await db
    .update(sessions)
    .set({ internalSessionId })
    .where(eq(sessions.id, sessionId))
    .returning();

  return updated[0] ?? null;
}

/**
 * Get or create a session (updates fields if it already exists)
 */
export async function getOrCreateSession(
  sessionId: string,
  agent: "claude-code" | "codex" = "claude-code",
  cwd: string = "~",
  model?: string
): Promise<Session> {
  const existing = await getSession(sessionId);

  if (!existing) {
    return createSession({ sessionId, agent, cwd, model });
  }

  // Build a minimal update payload; always refresh updatedAt
  const updatePayload: Partial<Session> = {
    updatedAt: new Date(),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(model !== undefined ? { model } : {}),
  };

  const updated = await db
    .update(sessions)
    .set(updatePayload)
    .where(eq(sessions.id, sessionId))
    .returning();

  return updated[0] ?? existing;
}

/**
 * Get the most recent message ID for session resumption
 */
export async function getLastNonUserMessageId(
  sessionId: string
): Promise<string | null> {
  try {
    const result = await db
      .select({ messageId: messages.messageId })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), ne(messages.role, "user")))
      .orderBy(desc(messages.createdAt))
      .limit(1);

    return result[0]?.messageId || null;
  } catch (error) {
    console.error("Error getting last message ID:", error);
    return null;
  }
}

/**
 * Create a user message row with a synthetic messageId for uniqueness
 */
export async function createUserMessage(
  sessionId: string,
  prompt: string
): Promise<Message> {
  const syntheticId = `user:${randomUUID()}`;
  const messageId = randomUUID();
  const message = await createMessage(sessionId, syntheticId, {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
    uuid: messageId,
    session_id: sessionId,
    parent_tool_use_id: null,
  });

  return message;
}

/**
 * Update session timestamp
 */
export async function updateSession(sessionId: string): Promise<void> {
  try {
    await db
      .update(sessions)
      .set({ updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
  } catch (error) {
    console.error("Error updating session:", error);
    // Non-critical error, don't throw
  }
}

/**
 * Update session working directory (cwd)
 */
export async function updateSessionCwd(
  sessionId: string,
  cwd: string
): Promise<void> {
  try {
    await db
      .update(sessions)
      .set({ cwd, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
  } catch (error) {
    console.error("Error updating session cwd:", error);
    throw new Error("Failed to update session cwd");
  }
}

/**
 * Update session name
 */
export async function updateSessionName(
  sessionId: string,
  name: string
): Promise<Session | null> {
  try {
    const result = await db
      .update(sessions)
      .set({ name, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId))
      .returning();

    return result[0] || null;
  } catch (error) {
    console.error("Error updating session name:", error);
    throw new Error("Failed to update session name");
  }
}

/**
 * Get all sessions ordered by updated timestamp (most recent first)
 */
export async function getAllSessions(): Promise<Session[]> {
  try {
    const result = await db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.updatedAt));

    return result;
  } catch (error) {
    console.error("Error getting all sessions:", error);
    throw new Error("Failed to retrieve sessions");
  }
}

/**
 * Delete a session and all of its messages
 */
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    // First delete all messages for the session
    await db.delete(messages).where(eq(messages.sessionId, sessionId));

    // Then delete the session itself
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  } catch (error) {
    console.error("Error deleting session:", error);
    throw new Error("Failed to delete session");
  }
}

/**
 * Append a message content to an existing Claude Code session message record.
 * This pushes the new SDKMessage into the `contents` JSONB array while updating
 * the `updatedAt` timestamp.
 */
export async function appendMessageContent(
  messageId: string,
  content: SDKMessage
): Promise<void> {
  try {
    // Fetch current contents for the message
    const [existing] = await db
      .select({ contents: messages.contents })
      .from(messages)
      .where(eq(messages.messageId, messageId));

    const currentContents = (existing?.contents as SDKMessage[] | null) ?? [];

    await db
      .update(messages)
      .set({
        contents: [...currentContents, content],
        updatedAt: new Date(),
      })
      .where(eq(messages.messageId, messageId));
  } catch (error) {
    console.error("Error appending message content:", error);
    // Non-critical – do not throw to avoid interrupting the stream
  }
}
