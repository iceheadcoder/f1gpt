import Together from "together-ai"
import { streamText } from "ai";
import { DataAPIClient } from "@datastax/astra-db-ts";


const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY || '';
const ASTRA_DB_NAMESPACE = process.env.ASTRA_DB_NAMESPACE || '';
const ASTRA_DB_COLLECTION = process.env.ASTRA_DB_COLLECTION || '';
const ASTRA_DB_API_ENDPOINT = process.env.ASTRA_DB_API_ENDPOINT || '';
const ASTRA_DB_APPLICATION_TOKEN = process.env.ASTRA_DB_APPLICATION_TOKEN || '';

const together = new Together()

if (!TOGETHER_API_KEY) {
    throw new Error(" Missing Together API key");
}

if (!ASTRA_DB_NAMESPACE || !ASTRA_DB_COLLECTION || !ASTRA_DB_API_ENDPOINT || !ASTRA_DB_APPLICATION_TOKEN) {
    throw new Error(" Missing required AstraDB environment variables.");
}


const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN);
const db = client.db(ASTRA_DB_API_ENDPOINT, { 
    namespace: ASTRA_DB_NAMESPACE 
});

interface ErrorResponse {
    error: string;
    details?: string;
}

export async function POST(req: Request) {
    try {
        const { messages } = await req.json();
        if (!messages || !Array.isArray(messages)) {
            throw new Error(" Invalid request: 'messages' must be an array.");
        }

        const latestMessage = messages[messages.length - 1]?.content;
        if (!latestMessage) throw new Error(" No user message found.");

        let docContext = "";

        
        const embeddingResponse = await fetch("https://api.together.xyz/v1/embeddings", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${TOGETHER_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ inputs: [latestMessage] })
        });

        if (!embeddingResponse.ok) {
            const errorText = await embeddingResponse.text();
            console.error("TOGETHER API Error:", errorText);
            throw new Error("Failed to fetch embeddings.");
        }

        const embeddingData = await embeddingResponse.json();
        if (!embeddingData?.embeddings?.length) {
            throw new Error("TOGETHER returned an invalid response.");
        }

        const embedding = embeddingData.embeddings[0];

        
        try {
            const collection = await db.collection(ASTRA_DB_COLLECTION);
            const cursor = await collection.find({}, {
                sort: {
                    $vector: embedding as number[]
                },
                limit: 5
            });

            const documents = await cursor.toArray();
            docContext = JSON.stringify(documents.map(doc => doc.text ?? ""));
        } catch (error) {
            console.error(" DB Error:", error);
            docContext = "";
        }

       
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
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(initialMessage)}\n\n`));

                let accumulatedContent = '';
                const result = await together.chat.completions.create({
                    model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
                    messages: [
                        {
                            "role": "system",
                            "content": `You are an AI assistant specializing in Formula One.
                            Use the below context to augment your knowledge based on Latest Information
                            prioritizing the **2024 season**.
                            Do NOT mention sources or missing information.
                            Always be kind and ask if the user needs any help.

                            ------------------------
                            START CONTEXT
                            ${docContext}
                            END CONTEXT
                            ------------------------

                            QUESTION: ${latestMessage}
                            ------------------------`
                        },
                        ...messages
                    ],
                });

                for await (const chunk of result.choices) {
                    accumulatedContent += chunk;
                    const data = {
                        id: Date.now().toString(),
                        role: 'assistant' as const,
                        content: accumulatedContent,
                        createdAt: new Date(),
                    };
                    
                    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                }

                
                await writer.write(encoder.encode('data: [DONE]\n\n'));
            } catch (error) {
                console.error("Streaming error:", error);
                const errorMessage = {
                    id: Date.now().toString(),
                    role: 'assistant' as const,
                    content: "Sorry, there was an error processing your request.",
                    createdAt: new Date(),
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(errorMessage)}\n\n`));
            } finally {
                await writer.close();
            }
        })().catch(async (error: unknown) => {
            console.error("Stream processing error:", error);
            const errorMessage = {
                id: Date.now().toString(),
                role: 'assistant' as const,
                content: "Sorry, there was an error processing your request.",
                createdAt: new Date(),
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(errorMessage)}\n\n`));
            await writer.close();
        });

        return new Response(stream.readable, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
            },
        });

    } catch (error: unknown) {
        console.error("API Error:", error);
        const errorResponse: ErrorResponse = {
            error: "Internal Server Error",
            details: error instanceof Error ? error.message : "Unknown error occurred"
        };
        
        return new Response(JSON.stringify(errorResponse), {
            status: 500,
            headers: { 
                "Content-Type": "application/json",
            }
        });
    }
}