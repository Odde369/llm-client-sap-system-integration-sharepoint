# Ollama Proxy

**Container:** `ollama-proxy`
**Port:** `4010`
**Source:** `docker/ollama-proxy/`

A transparent OpenAI-compatible API proxy that solves two problems with open-source LLMs (especially DeepSeek and Qwen models):

1. **Tool-call format normalization** — Some models return tool calls as plain text (XML, JSON blocks, keyword-based) instead of structured `tool_calls`. The proxy detects and converts these to proper OpenAI `tool_calls` format before LibreChat sees the response.

2. **Forced tool usage** — Injects a synthetic `__respond__` tool and sets `tool_choice="required"` so models always emit a tool call instead of free-form planning text.

---

## How It Works

### Request Pipeline

```
LibreChat → ollama-proxy → Upstream LLM (Ollama Cloud)
```

On every request that includes `tools`:
1. Proxy appends a synthetic `__respond__` tool to the tools list
2. Sets `tool_choice: "required"` (forces tool call output)
3. Forwards to `UPSTREAM_BASE`

### Response Pipeline

```
Upstream LLM → ollama-proxy → LibreChat
```

For streaming responses (SSE):
1. Proxy buffers chunks
2. If `finish_reason: "stop"` and the response text contains tool call patterns → parses and converts to `tool_calls`
3. If `__respond__` tool call detected → converts back to plain text response
4. TOOL_DATA_B64 substitution (see below)

For non-streaming:
- Same logic applied to the complete response body

---

## Tool-Call Text Patterns Detected

The proxy recognizes these non-standard formats:

| Pattern | Format |
|---------|--------|
| Hermes XML | `<tool_call>{"name": "...", "arguments": {...}}</tool_call>` |
| JSON block with tool key | `` ```json\n{"name": "...", "arguments": {...}}``` `` |
| DeepSeek line format | `tool_call_name: foo\ntool_call_arguments: {...}` |
| Bare JSON object | `{"name": "...", "arguments": {...}}` |
| Planning text keywords | Falls back to matching known tool names in free text |

All detected patterns are rebuilt into proper:
```json
{
  "tool_calls": [{
    "id": "call_...",
    "type": "function",
    "function": { "name": "...", "arguments": "..." }
  }]
}
```

---

## `__respond__` Tool

When the model needs to return a plain text answer (not call a tool), it calls `__respond__` with `{ "content": "..." }`. The proxy intercepts this and converts it back to a regular assistant message with `finish_reason: "stop"`. LibreChat receives a normal text response.

This mechanism prevents models from getting stuck in tool-call-only mode when they genuinely need to provide a text answer.

---

## `TOOL_DATA_B64` Injection

When the BTP Advisor agent calls `btp_health_dashboard`, the tool returns a large JSON payload. The LLM then generates a React artifact containing the literal string `TOOL_DATA_B64`. The proxy:

1. Detects the string `TOOL_DATA_B64` in the streaming artifact code
2. Looks for the most recent tool result from `btp_health_dashboard` in the request context
3. Replaces `TOOL_DATA_B64` with `base64(JSON.stringify(toolResult))`

This injects up to 200KB of data into the artifact without asking the LLM to copy it (which would cause truncation).

---

## Configuration

```yaml
# docker-compose.override.yml
ollama-proxy:
  environment:
    - UPSTREAM_BASE=https://ollama.com
    - PORT=4010
```

```env
# .env
OLLAMA_CLOUD_API_KEY=your-api-key
```

To route to a local Ollama instance instead of cloud:
```env
# in docker-compose.override.yml environment section
UPSTREAM_BASE=http://host.docker.internal:11434
```

---

## librechat.enterprise.yaml Registration

```yaml
endpoints:
  custom:
    - name: "Ollama Cloud"
      apiKey: "${OLLAMA_CLOUD_API_KEY}"
      baseURL: "http://ollama-proxy:4010/v1"
      models:
        fetch: false
        default: ["qwen3.5:397b", "gpt-oss:120b", "deepseek-v3.1:671b-cloud"]
      addParams:
        tool_choice: "auto"
        parallel_tool_calls: false
```
