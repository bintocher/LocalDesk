
/**
 * OpenAI-based runner - replacement for Claude SDK
 * Gives us full control over requests, tools, and streaming
 */

import OpenAI from 'openai';
import type { ServerEvent } from "../types.js";
import type { Session } from "./session-store.js";
import { loadApiSettings } from "./settings-store.js";
import { TOOLS, getSystemPrompt } from "./tools-definitions.js";
import { getInitialPrompt } from "./prompt-loader.js";
import { ToolExecutor } from "./tools-executor.js";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type RunnerOptions = {
  prompt: string;
  session: Session;
  resumeSessionId?: string;
  onEvent: (event: ServerEvent) => void;
  onSessionUpdate?: (updates: Partial<Session>) => void;
};

export type RunnerHandle = {
  abort: () => void;
};

const DEFAULT_CWD = process.cwd();

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
};

// Logging
const getLogsDir = () => {
  const logsDir = join(homedir(), '.agent-cowork', 'logs');
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  return logsDir;
};

const logApiRequest = (sessionId: string, data: any) => {
  try {
    const logsDir = getLogsDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `openai-request-${sessionId}-${timestamp}.json`;
    const filepath = join(logsDir, filename);
    
    writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[OpenAI Runner] Request logged to: ${filepath}`);
  } catch (error) {
    console.error('[OpenAI Runner] Failed to write log:', error);
  }
};

export async function runClaude(options: RunnerOptions): Promise<RunnerHandle> {
  const { prompt, session, onEvent, onSessionUpdate } = options;
  let aborted = false;

  const sendMessage = (type: string, content: any) => {
    onEvent({
      type: "stream.message" as any,
      payload: { sessionId: session.id, message: { type, ...content } as any }
    });
  };

  // Save to DB without triggering UI updates
  const saveToDb = (type: string, content: any) => {
    const sessionStore = (global as any).sessionStore;
    if (sessionStore && session.id) {
      sessionStore.recordMessage(session.id, { type, ...content });
    }
  };

  const sendPermissionRequest = (toolUseId: string, toolName: string, input: unknown, explanation?: string) => {
    onEvent({
      type: "permission.request",
      payload: { sessionId: session.id, toolUseId, toolName, input, explanation }
    });
  };

  // Start the query in the background
  (async () => {
    try {
      // Load settings
      const guiSettings = loadApiSettings();
      
      if (!guiSettings || !guiSettings.baseUrl || !guiSettings.model) {
        throw new Error('API settings not configured. Please set Base URL and Model in Settings.');
      }

      // Ensure baseURL ends with /v1 for OpenAI compatibility
      let baseURL = guiSettings.baseUrl;
      if (!baseURL.endsWith('/v1')) {
        baseURL = baseURL.replace(/\/$/, '') + '/v1';
      }

      console.log(`[OpenAI Runner] Starting with model: ${guiSettings.model}`);
      console.log(`[OpenAI Runner] Base URL: ${baseURL}`);
      console.log(`[OpenAI Runner] Temperature: ${guiSettings.temperature || 0.3}`);

      // Initialize OpenAI client
      const client = new OpenAI({
        apiKey: guiSettings.apiKey || 'dummy-key',
        baseURL: baseURL,
        dangerouslyAllowBrowser: false
      });

      // Initialize tool executor with API settings for web tools
      const toolExecutor = new ToolExecutor(session.cwd || DEFAULT_CWD, guiSettings);

      // Build conversation history from session
      const currentCwd = session.cwd || DEFAULT_CWD;
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: getSystemPrompt(currentCwd)
        }
      ];

      // Load previous messages from session history
      const sessionStore = (global as any).sessionStore;
      let lastUserPrompt = '';
      
      if (sessionStore && session.id) {
        const history = sessionStore.getSessionHistory(session.id);
        if (history && history.messages.length > 0) {
          console.log(`[OpenAI Runner] Loading ${history.messages.length} messages from history`);
          
          let currentAssistantMessage = '';
          
          // Convert session history to OpenAI format
          for (const msg of history.messages) {
            if (msg.type === 'user_prompt') {
              const promptText = (msg as any).prompt || '';
              
              // Flush any pending assistant message
              if (currentAssistantMessage.trim()) {
                messages.push({
                  role: 'assistant',
                  content: currentAssistantMessage.trim()
                });
                currentAssistantMessage = '';
              }
              
              // Track last user prompt to avoid duplication
              lastUserPrompt = promptText;
              
              messages.push({
                role: 'user',
                content: promptText
              });
            } else if (msg.type === 'text') {
              // Accumulate text into assistant message
              currentAssistantMessage += (msg as any).text || '';
            } else if (msg.type === 'tool_result') {
              // Add tool result as part of assistant message
              const output = (msg as any).output || '';
              currentAssistantMessage += `\n[Tool Output: ${output}]\n`;
            }
            // Skip other message types (tool_use, system, etc.)
          }
          
          // Flush final assistant message if any
          if (currentAssistantMessage.trim()) {
            messages.push({
              role: 'assistant',
              content: currentAssistantMessage.trim()
            });
          }
        }
      }

      // Add current prompt ONLY if it's different from the last one in history
      if (prompt !== lastUserPrompt) {
        // Format prompt with current date
        const formattedPrompt = getInitialPrompt(prompt);
        messages.push({
          role: 'user',
          content: formattedPrompt
        });
      }

      // Log request
      logApiRequest(session.id, {
        model: guiSettings.model,
        messages,
        tools: TOOLS,
        temperature: guiSettings.temperature || 0.3
      });

      // Send system init message
      sendMessage('system', {
        subtype: 'init',
        cwd: session.cwd || DEFAULT_CWD,
        session_id: session.id,
        tools: TOOLS.map(t => t.function.name),
        model: guiSettings.model,
        permissionMode: 'default'
      });

      // Update session with ID for resume support
      if (onSessionUpdate) {
        onSessionUpdate({ claudeSessionId: session.id });
      }

      // Main agent loop
      let iterationCount = 0;
      const MAX_ITERATIONS = 50;

      while (!aborted && iterationCount < MAX_ITERATIONS) {
        iterationCount++;
        console.log(`[OpenAI Runner] Iteration ${iterationCount}`);
        console.log(`[OpenAI Runner] Messages count: ${messages.length}`);
        console.log(`[OpenAI Runner] Last 3 messages:`, JSON.stringify(messages.slice(-3), null, 2));

        // Call OpenAI API
        const stream = await client.chat.completions.create({
          model: guiSettings.model,
          messages: messages as any[],
          tools: TOOLS as any[],
          temperature: guiSettings.temperature || 0.3,
          stream: true
        });

        let assistantMessage = '';
        let toolCalls: any[] = [];
        let currentToolCall: any = null;
        let contentStarted = false;

        // Process stream
        for await (const chunk of stream) {
          if (aborted) break;

          const delta = chunk.choices[0]?.delta;
          
          if (!delta) continue;

          // Text content
          if (delta.content) {
            // Send content_block_start on first chunk
            if (!contentStarted) {
              contentStarted = true;
              sendMessage('stream_event', {
                event: {
                  type: 'content_block_start',
                  content_block: {
                    type: 'text',
                    text: ''
                  },
                  index: 0
                }
              });
            }

            assistantMessage += delta.content;
            
            // Send streaming text
            sendMessage('stream_event', {
              event: {
                type: 'content_block_delta',
                delta: {
                  type: 'text_delta',
                  text: delta.content
                },
                index: 0
              }
            });
          }

          // Tool calls
          if (delta.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              if (toolCall.index !== undefined) {
                if (!toolCalls[toolCall.index]) {
                  toolCalls[toolCall.index] = {
                    id: toolCall.id || `call_${Date.now()}_${toolCall.index}`,
                    type: 'function',
                    function: {
                      name: toolCall.function?.name || '',
                      arguments: toolCall.function?.arguments || ''
                    }
                  };
                } else {
                  if (toolCall.function?.arguments) {
                    toolCalls[toolCall.index].function.arguments += toolCall.function.arguments;
                  }
                }
              }
            }
          }
        }

        // Send content_block_stop if content was streamed
        if (contentStarted) {
          sendMessage('stream_event', {
            event: {
              type: 'content_block_stop',
              index: 0
            }
          });
        }

        // If no tool calls, we're done
        if (toolCalls.length === 0) {
          // Send assistant message for UI display
          sendMessage('assistant', {
            message: {
              id: `msg_${Date.now()}`,
              content: [{ type: 'text', text: assistantMessage }]
            }
          });

          // Save as 'text' type to DB (without triggering UI update)
          saveToDb('text', {
            text: assistantMessage,
            uuid: `msg_${Date.now()}_db`
          });

          sendMessage('result', {
            subtype: 'success',
            is_error: false,
            duration_ms: 1000,
            duration_api_ms: 800,
            num_turns: iterationCount,
            result: assistantMessage,
            session_id: session.id,
            total_cost_usd: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0
            }
          });

          onEvent({
            type: "session.status",
            payload: { sessionId: session.id, status: "completed", title: session.title }
          });

          break;
        }

        // Add assistant message with tool calls to history
        messages.push({
          role: 'assistant',
          content: assistantMessage || '',
          tool_calls: toolCalls
        });

        // Save text response if any (before tool calls)
        if (assistantMessage.trim()) {
          saveToDb('text', {
            text: assistantMessage,
            uuid: `msg_text_${Date.now()}`
          });
        }

        // Send tool use messages
        for (const toolCall of toolCalls) {
          const toolInput = JSON.parse(toolCall.function.arguments || '{}');
          
          // For UI display - assistant message with tool_use
          sendMessage('assistant', {
            message: {
              id: `msg_${toolCall.id}`,
              content: [{
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.function.name,
                input: toolInput
              }]
            }
          });
          
          // For DB storage - tool_use type (without UI update)
          saveToDb('tool_use', {
            id: toolCall.id,
            name: toolCall.function.name,
            input: toolInput,
            uuid: `tool_${toolCall.id}`
          });
        }

        // Execute tools
        const toolResults: ChatMessage[] = [];

        for (const toolCall of toolCalls) {
          if (aborted) break;

          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

          console.log(`[OpenAI Runner] Executing tool: ${toolName}`, toolArgs);

          // Request permission
          const toolUseId = toolCall.id;
          sendPermissionRequest(toolUseId, toolName, toolArgs, toolArgs.explanation);

          // Execute tool immediately (permission is handled by default mode)
          const result = await toolExecutor.executeTool(toolName, toolArgs);

          // Add tool result to messages
          toolResults.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: result.success 
              ? (result.output || 'Success') 
              : `Error: ${result.error}`
          });

          // Send tool result message for UI
          sendMessage('user', {
            message: {
              content: [{
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content: result.success ? result.output : `Error: ${result.error}`,
                is_error: !result.success
              }]
            }
          });
          
          // Save for DB storage (without UI update)
          saveToDb('tool_result', {
            tool_use_id: toolCall.id,
            output: result.success ? result.output : `Error: ${result.error}`,
            is_error: !result.success,
            uuid: `tool_result_${toolCall.id}`
          });
        }

        // Add all tool results to messages
        messages.push(...toolResults);
      }

      if (iterationCount >= MAX_ITERATIONS) {
        throw new Error('Max iterations reached');
      }

    } catch (error) {
      console.error('[OpenAI Runner] Error:', error);
      
      onEvent({
        type: "session.status",
        payload: { 
          sessionId: session.id, 
          status: "error", 
          title: session.title, 
          error: String(error) 
        }
      });
    }
  })();

  return {
    abort: () => {
      aborted = true;
      console.log('[OpenAI Runner] Aborted');
    }
  };
}
