/**
 * Tool executors - actual implementation of each tool
 */

import { resolve, relative, isAbsolute } from 'path';
import type { ToolResult, ToolExecutionContext } from './tools/base-tool.js';
import type { ApiSettings } from '../types.js';

// Import tool executors
import { executeBashTool } from './tools/bash-tool.js';
import { executeReadTool } from './tools/read-tool.js';
import { executeWriteTool } from './tools/write-tool.js';
import { executeEditTool } from './tools/edit-tool.js';
import { executeGlobTool } from './tools/glob-tool.js';
import { executeGrepTool } from './tools/grep-tool.js';
import { WebSearchTool } from './tools/web-search.js';
import { ExtractPageContentTool } from './tools/extract-page-content.js';
import { executeMemoryTool } from './tools/memory-tool.js';

export { ToolResult };

export class ToolExecutor {
  private cwd: string;
  private apiSettings: ApiSettings | null;
  private webSearchTool: WebSearchTool | null = null;
  private extractPageTool: ExtractPageContentTool | null = null;

  constructor(cwd: string, apiSettings: ApiSettings | null = null) {
    this.cwd = resolve(cwd); // Normalize path
    this.apiSettings = apiSettings;
    
    // Initialize web tools if Tavily API key is available
    if (apiSettings?.tavilyApiKey) {
      this.webSearchTool = new WebSearchTool(apiSettings.tavilyApiKey);
      this.extractPageTool = new ExtractPageContentTool(apiSettings.tavilyApiKey);
    }
  }

  // Security: Check if path is within allowed directory
  private isPathSafe(filePath: string): boolean {
    const absolutePath = resolve(this.cwd, filePath);
    const relativePath = relative(this.cwd, absolutePath);
    
    // Path is safe if it doesn't start with '..' (doesn't go up from cwd)
    const isSafe = !relativePath.startsWith('..') && !isAbsolute(relativePath);
    
    if (!isSafe) {
      console.warn(`[Security] Blocked access to path outside working directory: ${filePath}`);
    }
    
    return isSafe;
  }

  private getContext(): ToolExecutionContext {
    return {
      cwd: this.cwd,
      isPathSafe: this.isPathSafe.bind(this)
    };
  }

  async executeTool(toolName: string, args: Record<string, any>): Promise<ToolResult> {
    console.log(`[Tool Executor] Executing ${toolName}`, args);

    const context = this.getContext();

    try {
      switch (toolName) {
        case 'Bash':
          return await executeBashTool(args as any, context);
        
        case 'Read':
          return await executeReadTool(args as any, context);
        
        case 'Write':
          return await executeWriteTool(args as any, context);
        
        case 'Edit':
          return await executeEditTool(args as any, context);
        
        case 'Glob':
          return await executeGlobTool(args as any, context);
        
        case 'Grep':
          return await executeGrepTool(args as any, context);
        
        case 'WebSearch':
          return await this.executeWebSearch(args);
        
        case 'ExtractPageContent':
          return await this.executeExtractPage(args);
        
        case 'Memory':
          return await executeMemoryTool(args as any, context);
        
        default:
          return {
            success: false,
            error: `Unknown tool: ${toolName}`
          };
      }
    } catch (error) {
      console.error(`[Tool Executor] Error in ${toolName}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async executeWebSearch(args: any): Promise<ToolResult> {
    if (!this.webSearchTool) {
      return {
        success: false,
        error: 'Web search is not available. Please configure Tavily API key in Settings.'
      };
    }

    try {
      const results = await this.webSearchTool.search({
        query: args.query,
        explanation: args.explanation,
        max_results: args.max_results || 5
      });

      const formatted = this.webSearchTool.formatResults(results);
      
      return {
        success: true,
        output: formatted
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Web search failed: ${error.message}`
      };
    }
  }

  private async executeExtractPage(args: any): Promise<ToolResult> {
    if (!this.extractPageTool) {
      return {
        success: false,
        error: 'Page extraction is not available. Please configure Tavily API key in Settings.'
      };
    }

    try {
      const results = await this.extractPageTool.extract({
        urls: args.urls,
        explanation: args.explanation
      });

      const formatted = this.extractPageTool.formatResults(results);
      
      return {
        success: true,
        output: formatted
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Page extraction failed: ${error.message}`
      };
    }
  }
}
