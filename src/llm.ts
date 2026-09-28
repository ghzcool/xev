import OpenAI from "openai";

export interface LLMClientConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface LLMResult {
  content: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

function stripCodeFences(content: string): string {
  const cleaned = content.trim();
  if (!cleaned.startsWith("```")) return cleaned;

  const firstNewline = cleaned.indexOf("\n");
  const lastFence = cleaned.lastIndexOf("```");
  if (lastFence > firstNewline) {
    return cleaned.slice(firstNewline + 1, lastFence).trim();
  }
  return cleaned;
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
          "You are a precise structured evaluation engine. You always return only the requested index:value answer list, with no explanations or markdown.",
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

  return {
    content: stripCodeFences(content),
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
  };
}
