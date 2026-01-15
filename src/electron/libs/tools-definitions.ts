/**
 * OpenAI-compatible tool definitions for Qwen and other models
 */

import { ALL_TOOL_DEFINITIONS } from './tools/index.js';
import { getSystemPrompt, SYSTEM_PROMPT } from './prompt-loader.js';
import type { ApiSettings } from '../types.js';

// Get tools based on settings
export function getTools(settings: ApiSettings | null) {
  if (!settings?.enableMemory) {
    // Filter out Memory tool if not enabled
    return ALL_TOOL_DEFINITIONS.filter(tool => tool.function.name !== 'Memory');
  }
  return ALL_TOOL_DEFINITIONS;
}

// Export all tools (for backward compatibility)
export const TOOLS = ALL_TOOL_DEFINITIONS;

// Export prompt functions
export { getSystemPrompt, SYSTEM_PROMPT };
