/**
 * WebSearchTool - Search the web using Tavily API
 */

import fetch from 'node-fetch';
import type { ToolDefinition, ToolResult, ToolExecutionContext } from './base-tool.js';

export interface WebSearchParams {
  query: string;
  explanation: string;
  max_results?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface TavilySearchResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
  }>;
}

export const WebSearchToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "WebSearch",
    description: "Search the web for real-time information - USE AS LAST RESORT. ALWAYS try Grep, Glob, and Read tools FIRST before using this tool. This tool searches the INTERNET, not your local repository. Use ONLY when information is NOT in the local codebase (external library documentation, current events, news, public APIs, general knowledge).",
    parameters: {
      type: "object",
      properties: {
        explanation: {
          type: "string",
          description: "Why this search is needed and what to expect"
        },
        query: {
          type: "string",
          description: "Search query in same language as user request. Use specific terms and context. For acronyms, add context. Use quotes for exact phrases."
        },
        max_results: {
          type: "number",
          description: "Maximum results (1-10, default: 5)",
          minimum: 1,
          maximum: 10
        }
      },
      required: ["explanation", "query"]
    }
  }
};

export class WebSearchTool {
  private apiKey: string;
  private baseUrl = 'https://api.tavily.com';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async search(params: WebSearchParams): Promise<SearchResult[]> {
    const { query, max_results = 5 } = params;

    console.log(`[WebSearch] Query: "${query}", max_results: ${max_results}`);

    if (!this.apiKey || this.apiKey === 'dummy-key') {
      throw new Error('Tavily API key not configured. Please set it in Settings.');
    }

    try {
      const response = await fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          max_results: Math.min(max_results, 10),
          include_raw_content: false,
          include_answer: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Tavily API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as TavilySearchResponse;

      const results: SearchResult[] = data.results.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.content.substring(0, 200) + (result.content.length > 200 ? '...' : ''),
        score: result.score,
      }));

      console.log(`[WebSearch] Found ${results.length} results`);
      return results;

    } catch (error) {
      console.error('[WebSearch] Error:', error);
      throw error;
    }
  }

  formatResults(results: SearchResult[]): string {
    let formatted = '🔍 **Web Search Results**\n\n';
    formatted += '**IMPORTANT**: When citing information from these sources, ALWAYS include the source number [1], [2], etc. and the URL in your response.\n\n';

    results.forEach((result, index) => {
      const sourceNum = index + 1;
      formatted += `**[${sourceNum}]** ${result.title}\n`;
      formatted += `🔗 URL: ${result.url}\n`;
      formatted += `📝 ${result.snippet}\n\n`;
    });

    formatted += '\n---\n';
    formatted += '**Instructions for citing sources:**\n';
    formatted += '- Use [1], [2], etc. to reference sources in your answer\n';
    formatted += '- Include clickable URLs when mentioning specific information\n';
    formatted += '- Example: "According to [1](url), the price is..."\n';

    return formatted;
  }
}

