// main.ts
import { Hono } from "jsr:@hono/hono";
import { streamSSE } from "jsr:@hono/hono/streaming";
import { encode } from "jsr:@std/encoding/hex";

const app = new Hono();

// Optional basic logging middleware
app.use('*', async (c, next) => {
    console.log(` ${c.req.method} ${c.req.url}`);
    await next();
    console.log(` ${c.res.status} ${c.req.method} ${c.req.url}`);
});

// OpenAI compatible Chat Completions endpoint
app.post("/v1/chat/completions", async (c) => {
    let requestBody;
    try {
        requestBody = await c.req.json();
    } catch (e) {
        return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
    }

    // --- Basic Request Validation ---
    if (!requestBody.model ||
        typeof requestBody.model !== 'string') {
        return c.json({ error: { message: "Missing or invalid 'model' parameter", type: "invalid_request_error" } }, 400);
    }
    if (!requestBody.messages || !Array.isArray(requestBody.messages) ||
        requestBody.messages.length === 0) {
        return c.json({ error: { message: "Missing or invalid 'messages' parameter", type: "invalid_request_error" } }, 400);
    }

    const isStreaming = requestBody.stream === true;

    // --- Get Gemini Authentication Credentials (from Environment Variables) ---
    // Requires --allow-env permission [1, 2]
    const psid = Deno.env.get("GEMINI_PSID");
    const psidts = Deno.env.get("GEMINI_PSIDTS"); // May be undefined

    if (!psid) {
        console.error("GEMINI_PSID environment variable not set.");
        return c.json({ error: { message: "Server configuration error: Missing Gemini credentials.", type: "api_error" } }, 500);
    }

    // --- Prepare Python Script Input ---
    const pythonInput = {
        psid: psid,
        psidts: psidts, // Can be null or undefined
        model: requestBody.model,
        messages: requestBody.messages,
    };

    // --- Execute Python Script ---
    // Requires --allow-run=python3 permission [1, 25]
    const command = new Deno.Command("python3", {
        args: ["python/gemini_adapter.py"], // Ensure path is correct
        stdin: "piped", // [10, 11]
        stdout: "piped", // [10, 11]
        stderr: "piped", // [10, 11]
    });

    let pythonResultJson: any;
    let pythonErrorJson: any;
    let exitCode: number = -1;

    try {
        const process = command.spawn(); // [10, 11]

        // Write input to Python script's stdin
        const writer = process.stdin.getWriter(); // [10, 11]
        await writer.write(new TextEncoder().encode(JSON.stringify(pythonInput)));
        await writer.close(); // Close stdin to signal end of input [10]

        // Wait for Python process to complete and get output
        const { code, stdout, stderr } = await process.output(); // [10]
        exitCode = code;

        const outputStr = new TextDecoder().decode(stdout); // [10]
        const errorStr = new TextDecoder().decode(stderr); // [10]

        // --- Handle Python Script Output/Error ---
        if (code !== 0) {
            // Python script exited abnormally
            try {
                pythonErrorJson = JSON.parse(errorStr ||
                    "{}"); // Try parsing JSON error from stderr
            } catch (parseError) {
                pythonErrorJson = {
                    error: {
                        message: `Python script exited with code ${code}. Stderr: ${errorStr ||
                            '(empty)'}`, type: "python_script_error"
                    }
                };
            }
            console.error("Python script error:", pythonErrorJson);
            // Return Python script error or generic error
            return c.json(pythonErrorJson.error ? pythonErrorJson : { error: pythonErrorJson }, 500);
        }

        // Python script exited successfully, parse stdout
        try {
            pythonResultJson = JSON.parse(outputStr);
            if (!pythonResultJson ||
                typeof pythonResultJson.text !== 'string') {
                throw new Error("Invalid JSON structure from Python script stdout.");
            }
        } catch (parseError) {
            console.error("Failed to parse Python script stdout:", parseError, "Stdout content:", outputStr);
            return c.json({ error: { message: "Internal server error: Failed to process Gemini response.", type: "api_error" } }, 500);
        }

    } catch (e) {
        console.error("Error executing or communicating with Python script:", e);
        return c.json({ error: { message: `Internal server error: ${e.message}`, type: "api_error" } }, 500);
    }

    // --- Format and Return Response ---
    const responseId = `chatcmpl-${generateRandomId()}`;
    const createdTimestamp = Math.floor(Date.now() / 1000);

    if (!isStreaming) {
        // --- Non-Streaming Response ---
        const responsePayload = {
            id: responseId,
            object: "chat.completion", // [8]
            created: createdTimestamp,
            model: requestBody.model, // Return requested model
            choices: [{ // 添加了缺失的初始化
                index: 0,
                message: {
                    role: "assistant",
                    content: pythonResultJson.text
                },
                finish_reason: "stop"
            }],
            usage: { // Token usage not supported [9, 35]
                prompt_tokens: null,
                completion_tokens: null,
                total_tokens: null,
            },
        };
        return c.json(responsePayload);

    } else {
        // --- Streaming Response (Simulated SSE) ---
        return streamSSE(c, async (stream) => { // [13, 14]
            const fullText = pythonResultJson.text;
            const streamId = `sse-${responseId}`; // ID for SSE events

            // 1. Send the first chunk with the role [15, 16, 17, 18]
            const firstChunkData = {
                id: responseId,
                object: "chat.completion.chunk", // [8]
                created: createdTimestamp,
                model: requestBody.model,
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }], // [8, 15]
                usage: null,
            };
            await stream.writeSSE({ data: JSON.stringify(firstChunkData), event: 'message', id: `${streamId}-0` }); // [13, 14]
            await stream.sleep(10); // Small delay

            // 2. Send the content in chunks
            const words = fullText.split(/(\s+)/).filter(Boolean); // Simple split by space
            let chunkIndex = 1;
            for (const word of words) {
                const chunkData = {
                    id: responseId,
                    object: "chat.completion.chunk",
                    created: createdTimestamp,
                    model: requestBody.model,
                    choices: [{ index: 0, delta: { content: word }, finish_reason: null }], // [8, 15, 16, 17, 18]
                    usage: null,
                };
                await stream.writeSSE({ data: JSON.stringify(chunkData), event: 'message', id: `${streamId}-${chunkIndex}` });
                chunkIndex++;
                await stream.sleep(50); // Simulate typing delay
            }

            // 3. Send the final chunk with finish_reason [8, 15]
            const finalChunkData = {
                id: responseId,
                object: "chat.completion.chunk",
                created: createdTimestamp,
                model: requestBody.model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }], // Empty delta, finish_reason stop [8]
                usage: null, // OpenAI stream usage [17]
            };
            await stream.writeSSE({ data: JSON.stringify(finalChunkData), event: 'message', id: `${streamId}-final` });
            await stream.sleep(10);

            // 4. Send the [DONE] message [5, 8, 16]
            await stream.writeSSE({ data: "[DONE]", event: 'message', id: `${streamId}-done` });

        }, (err, stream) => {
            // Error handler for streamSSE [14]
            console.error("Error during SSE streaming:", err);
        });
    }
});

// Simple root handler
app.get("/", (c) => c.text("Gemini to OpenAI Proxy is running!"));

// Generate a random ID
function generateRandomId(length = 24): string {
    const buffer = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(buffer); // [3]
    return encode(buffer).slice(0, length); // [3]
}

// Start the server
Deno.serve(app.fetch); // [2, 23]
console.log("Server listening on http://localhost:8000");