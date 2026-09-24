import OpenAI from "openai";
import type { LLMRawOutput } from "./types";

export interface LLMClientConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface LLMResult {
  output: LLMRawOutput;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

function parseLLMResponse(content: string): LLMRawOutput {
  let cleaned = content.trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    const lastFence = cleaned.lastIndexOf("```");
    if (lastFence > firstNewline) {
      cleaned = cleaned.slice(firstNewline + 1, lastFence).trim();
    }
  }

  // Try to extract JSON from the response
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in LLM response: ${cleaned.slice(0, 200)}`);
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error(`Invalid JSON in LLM response: ${jsonMatch[0].slice(0, 200)}`);
  }
}

export async function callLLM(
  prompt: string,
  config: LLMClientConfig
): Promise<LLMResult> {
  const client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });

  const response = await client.chat.completions.create({
    model: config.model,
    messages: [
      {
        role: "system",
        content:
          "You are a precise structured evaluation engine. You always return valid JSON with no explanations or markdown.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned empty response");
  }

  const output = parseLLMResponse(content);

  return {
    output,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
  };
}
