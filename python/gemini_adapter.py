# python/gemini_adapter.py
import sys
import json
import asyncio
import os
try:
    from gemini_webapi import GeminiClient
    # from gemini_webapi.constants import Model # If needed [5]
except ImportError:
    print(json.dumps({
        "success": False,
        "error": {"type": "ImportError", "message": "Failed to import gemini_webapi. Make sure it's installed in the Python environment."}
    }), file=sys.stderr)
    sys.exit(1)

# --- Read Input from stdin ---
input_data = ""
try:
    input_data = sys.stdin.read() # [8]
    params = json.loads(input_data)
except json.JSONDecodeError as e:
    error_output = json.dumps({
        "success": False,
        "error": {"type": "JSONDecodeError", "message": f"Failed to decode stdin JSON: {e}"}
    })
    print(error_output, file=sys.stderr)
    sys.exit(1)
except Exception as e:
    error_output = json.dumps({
        "success": False,
        "error": {"type": type(e).__name__, "message": f"Error reading stdin: {e}"}
    })
    print(error_output, file=sys.stderr)
    sys.exit(1)

# --- Extract Parameters ---
psid = params.get('psid')
psidts = params.get('psidts') # May be None
model_requested = params.get('model', 'unspecified')
messages = params.get('messages',)

if not psid:
    error_output = json.dumps({
        "success": False,
        "error": {"type": "ValueError", "message": "Missing 'psid' in input parameters."}
    })
    print(error_output, file=sys.stderr)
    sys.exit(1)

if not messages:
    error_output = json.dumps({
        "success": False,
        "error": {"type": "ValueError", "message": "Missing or empty 'messages' array in input parameters."}
    })
    print(error_output, file=sys.stderr)
    sys.exit(1)

# --- Construct Prompt (Simplified: Concatenate content) ---
prompt_parts = []  # 初始化为空列表
for msg in messages:
    if msg.get('content'):
        prompt_parts.append(str(msg['content']))

prompt = "\n".join(prompt_parts)

if not prompt:
     error_output = json.dumps({
        "success": False,
        "error": {"type": "ValueError", "message": "Could not construct a non-empty prompt from messages."}
    })
     print(error_output, file=sys.stderr)
     sys.exit(1)

# --- Define Async Function to Call Gemini ---
async def call_gemini(secure_psid, secure_psidts, user_prompt, model_name):
    client = None
    try:
        # Initialize GeminiClient [5]
        client = GeminiClient(Secure_1PSID=secure_psid, Secure_1PSIDTS=secure_psidts or None)

        # Optional: Initialize connection explicitly
        # await client.init(timeout=30) # [5]

        # Call Gemini API [5]
        response = await client.generate_content(user_prompt, model=model_name)

        # Extract results
        text_content = response.text # [5]
        # Try to get actual model used (if available, fallback to requested)
        model_used = getattr(response, 'model', model_name)

        return {
            "success": True,
            "text": text_content,
            "model_used": model_used,
        }

    except Exception as e:
        # Capture any exception during API call
        return {
            "success": False,
            "error": {"type": type(e).__name__, "message": str(e)}
        }
    finally:
        # Cleanup (if needed by the library)
        pass

# --- Main Execution Logic ---
if __name__ == "__main__":
    # Run the async function
    result = asyncio.run(call_gemini(psid, psidts, prompt, model_requested))

    # --- Output Result ---
    if result.get("success"):
        # Success: Print JSON result to stdout
        print(json.dumps(result)) # To stdout
        sys.exit(0) # Exit code 0
    else:
        # Failure: Print JSON error to stderr and exit with non-zero code
        print(json.dumps(result), file=sys.stderr) # To stderr
        sys.exit(1) # Exit code 1