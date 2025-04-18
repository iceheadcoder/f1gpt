import { HfInference } from '@huggingface/inference';
import { DataAPIClient } from "@datastax/astra-db-ts";

const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY || '';
const ASTRA_DB_NAMESPACE = process.env.ASTRA_DB_NAMESPACE || '';
const ASTRA_DB_COLLECTION = 'f1gpt2';
const ASTRA_DB_API_ENDPOINT = process.env.ASTRA_DB_API_ENDPOINT || '';
const ASTRA_DB_APPLICATION_TOKEN = process.env.ASTRA_DB_APPLICATION_TOKEN || '';

if (!HUGGINGFACE_API_KEY) {
    throw new Error("Missing Hugging Face API key");
}

if (!ASTRA_DB_NAMESPACE || !ASTRA_DB_API_ENDPOINT || !ASTRA_DB_APPLICATION_TOKEN) {
    throw new Error("Missing required AstraDB env variables");
}

const hf = new HfInference(HUGGINGFACE_API_KEY);
const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN);
const db = client.db(ASTRA_DB_API_ENDPOINT, {
    namespace: ASTRA_DB_NAMESPACE
});

const LLM_MODEL = "mistralai/Mixtral-8x7B-Instruct-v0.1";
const EMBEDDING_MODEL = "intfloat/e5-large-v2";

interface ErrorResponse {
    error: string;
    details?: string;
}

function formatUTCDateTime(): string {
    const now = new Date();
    return now.toISOString()
        .replace('T', ' ')
        .slice(0, 19);
}

function ensureFlatNumberArray(input: any): number[] {
    if (!input) {
        throw new Error('No embedding received');
    }

    if (Array.isArray(input) && !Array.isArray(input[0])) {
        return input as number[];
    }

    if (Array.isArray(input) && Array.isArray(input[0])) {
        return input[0] as number[];
    }

    if (input.data && Array.isArray(input.data)) {
        return input.data as number[];
    }

    throw new Error('Invalid embedding format received');
}

export async function POST(req: Request) {
    const currentDateTime = formatUTCDateTime();
    try {
        const { messages, user = 'iceheadcoder' } = await req.json();
        if (!messages || !Array.isArray(messages)) {
            throw new Error("Invalid request: 'messages' must be an array");
        }

        const latestMessage = messages[messages.length - 1]?.content;
        if (!latestMessage) throw new Error("No user message found");
        
        let relevantDocuments: Array<{
            content: string;
            similarity: number;
            index: number;
        }> = [];

        try {
            console.log(`[${currentDateTime}] Processing query for user ${user}`);

            const rawEmbedding = await hf.featureExtraction({
                model: EMBEDDING_MODEL,
                inputs: latestMessage,
            });

            const embedding = ensureFlatNumberArray(rawEmbedding);

            if (embedding.length !== 1024) {
                throw new Error(`Invalid embedding dimension: ${embedding.length}`);
            }

            console.log(`[${currentDateTime}] Generated embedding vector of length: ${embedding.length}`);

            const collection = await db.collection(ASTRA_DB_COLLECTION);
            const cursor = await collection.find(
                {} as any, // Add appropriate filters if needed
                {
                    sort: {
                        $vector: embedding
                    },
                    limit: 5,
                    includeSimilarity: true
                }
            );

            const results = await cursor.toArray();
            relevantDocuments = results
                .filter(doc => doc.$similarity && doc.$similarity > 0.7)
                .map((doc, index) => ({
                    content: doc.text || "",
                    similarity: doc.$similarity || 0,
                    index: index + 1
                }));

            console.log(`[${currentDateTime}] Found ${relevantDocuments.length} relevant documents`);

        } catch (error) {
            console.error(`[${currentDateTime}] Search error for user ${user}:`, error);
            relevantDocuments = [];
        }

        const formattedContext = relevantDocuments.length > 0
            ? relevantDocuments.map(doc => doc.content).join('\n\n')
            : "No relevant documents found.";

        const encoder = new TextEncoder();
        const stream = new TransformStream();
        const writer = stream.writable.getWriter();

        (async () => {
            try {
                const initialMessage = {
                    id: Date.now().toString(),
                    role: 'assistant' as const,
                    content: '',
                    createdAt: new Date(),
                    timestamp: currentDateTime,
                    user: user
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(initialMessage)}\n\n`));

                let accumulatedContent = '';

                const systemPrompt = `You are F1GPT, a Formula 1 expert assistant. Current date: ${currentDateTime} UTC.
CRITICAL RULES:
- Only use the context provided below. Do not add any details that are not present.
- If the context does not include the answer, respond with "I don't have enough information to answer that question".
- DO NOT reference events after the current date (${currentDateTime}) unless they are explicitly in the context.
- Do not speculate or provide information about events not covered in the context.
- Provide only factual answers and DO NOT include any disclaimers in your output.
- Add emojis only when required, do not add it always.

Context:
${formattedContext}

Question: ${latestMessage}

Your response:`;

                const response = await hf.textGenerationStream({
                    model: LLM_MODEL,
                    inputs: `[INST]${systemPrompt}[/INST]`,
                    parameters: {
                        max_new_tokens: 1000,
                        temperature: 0.01,  // Nearly deterministic
                        top_p: 0.1,       // Conservative token sampling
                        repetition_penalty: 1.1,
                        stop_sequences: ["</s>"]
                    }
                });

                for await (const chunk of response) {
                    if (chunk.token.text) {
                        accumulatedContent += chunk.token.text;
                        accumulatedContent = accumulatedContent.replace(/<\/s>$/, '');
                        const data = {
                            id: Date.now().toString(),
                            role: 'assistant' as const,
                            content: accumulatedContent.trim(),
                            createdAt: new Date(),
                            timestamp: currentDateTime,
                            user: user
                        };

                        await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                    }
                }

                await writer.write(encoder.encode(`data: [DONE]\n\n`));
            } catch (error) {
                console.error(`[${currentDateTime}] Streaming error for user ${user}:`, error);
                const errorMessage = {
                    id: Date.now().toString(),
                    role: 'assistant' as const,
                    content: "Sorry, there was an error processing your request",
                    createdAt: new Date(),
                    timestamp: currentDateTime,
                    user: user
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(errorMessage)}\n\n`));
            } finally {
                await writer.close();
            }
        })().catch(async (error: unknown) => {
            console.error(`[${currentDateTime}] Stream error for user ${user}:`, error);
            const errorMessage = {
                id: Date.now().toString(),
                role: 'assistant' as const,
                content: "Sorry, there was an error processing your request.",
                createdAt: new Date(),
                timestamp: currentDateTime,
                user: user
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(errorMessage)}\n\n`));
            await writer.close();
        });

        return new Response(stream.readable, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive'
            },
        });
    } catch (error: unknown) {
        console.error(`[${currentDateTime}] API Error:`, error);
        const errorResponse: ErrorResponse = {
            error: "Internal Server Error",
            details: error instanceof Error ? error.message : "Unknown Error occurred"
        };

        return new Response(JSON.stringify(errorResponse), {
            status: 500,
            headers: {
                "Content-Type": "application/json"
            }
        });
    }
}
