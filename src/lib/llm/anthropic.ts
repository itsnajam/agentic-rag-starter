import type { Llm, LlmEvent, LlmMessage } from "./llm";

/** The event shapes this code reads from the streaming response. */
type RawEvent = {
  type: string;
  message?: { usage?: { input_tokens?: number } };
  delta?: { type?: string; text?: string };
  usage?: { output_tokens?: number };
};

type CreateParams = {
  model: string;
  max_tokens: number;
  system: string;
  messages: LlmMessage[];
  stream: true;
};

export type AnthropicClient = {
  messages: {
    create(params: CreateParams): Promise<AsyncIterable<RawEvent>>;
  };
};

/**
 * Claude, through the official SDK shape: `messages.create` with `stream: true`,
 * text arriving as `content_block_delta`. The client is injected so the tests can
 * drive this class with a scripted stream and never touch the network.
 */
export class AnthropicLlm implements Llm {
  readonly name = "claude";
  readonly isModel = true;

  constructor(
    private readonly client: AnthropicClient,
    readonly model: string
  ) {}

  async *stream(system: string, messages: readonly LlmMessage[], maxTokens: number): AsyncGenerator<LlmEvent> {
    const stream = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    });

    let inputTokens = 0;
    let outputTokens = 0;
    for await (const event of stream) {
      if (event.type === "message_start") inputTokens = event.message?.usage?.input_tokens ?? 0;
      else if (event.type === "content_block_delta") {
        const text = event.delta?.type === "text_delta" ? event.delta.text ?? "" : "";
        if (text) yield { type: "text", text };
      } else if (event.type === "message_delta") outputTokens = event.usage?.output_tokens ?? outputTokens;
    }
    yield { type: "usage", inputTokens, outputTokens };
  }
}

/** Loaded only when a key is present, so nothing here needs the SDK at build time. */
export async function createAnthropicLlm(apiKey: string, model: string): Promise<Llm> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey }) as unknown as AnthropicClient;
  return new AnthropicLlm(client, model);
}
