// Synthetic test gateway only. Never part of the product image or provider routing.
const http = require("node:http");
const answer = "SYNTHETIC_RUNTIME_ACCEPTANCE";
const proxyProofs = new Set();
const gatewayProofs = new Set();
const toolRequests = new Set();
const toolNames = new Map();
const proxyAuthorization =
  "Basic " +
  Buffer.from("synthetic_project:synthetic-scoped-fixture-key").toString(
    "base64",
  );
function proxyResponse(target, authorization) {
  const match =
    /^http:\/\/native-proxy-fixture\.invalid\/(codex|grok|claude|pi)$/.exec(
      target,
    );
  if (!match || authorization !== proxyAuthorization)
    return { status: 407, body: "synthetic proxy denied" };
  proxyProofs.add(match[1]);
  return { status: 200, body: "synthetic-proxy-ok" };
}
const proxy = http.createServer((request, response) => {
  const result = proxyResponse(
    request.url,
    request.headers["proxy-authorization"],
  );
  response.writeHead(result.status, {
    "proxy-authenticate": 'Basic realm="synthetic-fixture"',
  });
  response.end(result.body);
});
proxy.on("connect", (request, socket) => {
  if (
    request.url !== "native-proxy-fixture.invalid:80" ||
    request.headers["proxy-authorization"] !== proxyAuthorization
  ) {
    socket.end(
      "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
    );
    return;
  }
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  socket.once("data", (data) => {
    const path = data.toString().split(" ")[1];
    const result = proxyResponse(
      "http://native-proxy-fixture.invalid" + path,
      request.headers["proxy-authorization"],
    );
    socket.end(
      `HTTP/1.1 ${result.status} Fixture\r\nContent-Length: ${Buffer.byteLength(result.body)}\r\nConnection: close\r\n\r\n${result.body}`,
    );
  });
});
proxy.listen(4101, "0.0.0.0");
function nativeTool(input, raw) {
  const harness = /^synthetic-proxy-(codex|grok|claude|pi)$/.exec(
    input.model,
  )?.[1];
  if (!harness) return {};
  if (toolRequests.has(harness))
    return {
      answer:
        proxyProofs.has(harness) &&
        gatewayProofs.has(harness) &&
        raw.includes("PROXY_TOOL_OK")
          ? "PROXY_TOOL_VERIFIED"
          : "PROXY_TOOL_FAILED",
    };
  const tools = (input.tools ?? [])
    .flatMap((tool) => tool.tools ?? [tool])
    .map((tool) => tool.function ?? tool);
  const selected = [
    "exec_command",
    "Bash",
    "bash",
    "run_terminal_cmd",
    "run_terminal_command",
    "run_shell_command",
    "shell_command",
    "shell",
    "run_command",
  ]
    .map((name) => tools.find((tool) => tool.name === name))
    .find(Boolean);
  if (!selected)
    throw new Error(
      "Synthetic shell tool unavailable: " +
        tools.map((tool) => tool.name).join(", "),
    );
  const schema = selected.parameters ?? selected.input_schema ?? {};
  const properties = schema.properties ?? {};
  const key = ["cmd", "command"].find((key) => properties[key]);
  if (!key)
    throw new Error(
      "Synthetic shell tool command parameter unavailable: " + selected.name,
    );
  const program = `const assert=require("node:assert/strict");for(const key of ["HTTP_PROXY","HTTPS_PROXY","NO_PROXY","NODE_USE_ENV_PROXY"])assert.ok(process.env[key],"Scoped proxy environment missing");Promise.all([fetch("http://native-proxy-fixture.invalid/${harness}").then(r=>r.text()),fetch("http://api:4100/native-gateway-proof/${harness}").then(r=>r.text())]).then(([proxy,gateway])=>{assert.equal(proxy,"synthetic-proxy-ok");assert.equal(gateway,"synthetic-gateway-ok");console.log("PROXY_TOOL_OK")}).catch(()=>{console.error("PROXY_TOOL_FAILED");process.exit(1)})`;
  const command = "node -e '" + program + "'";
  const args = {
    [key]: properties[key].type === "array" ? ["sh", "-c", command] : command,
  };
  if (properties.is_background) args.is_background = false;
  if (properties.description)
    args.description = "Synthetic scoped proxy tool check";
  toolRequests.add(harness);
  toolNames.set(harness, selected.name);
  return {
    tool: {
      name: selected.name,
      arguments: JSON.stringify(args),
      id: "call_fixture_" + harness,
    },
  };
}
const usage = {
  input_tokens: 8,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 4,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 12,
};
http
  .createServer(async (request, response) => {
    if (request.url === "/") {
      response.end("gateway-fixture");
      return;
    }
    const status = /^\/fixture-status\/(codex|grok|claude|pi)$/.exec(
      request.url,
    );
    if (status) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          toolRequested: toolRequests.has(status[1]),
          tool: toolNames.get(status[1]),
          proxyObserved: proxyProofs.has(status[1]),
          gatewayObserved: gatewayProofs.has(status[1]),
        }),
      );
      return;
    }
    const proof = /^\/native-gateway-proof\/(codex|grok|claude|pi)$/.exec(
      request.url,
    );
    if (proof) {
      if (request.headers["proxy-authorization"]) {
        response.writeHead(400);
        response.end();
        return;
      }
      gatewayProofs.add(proof[1]);
      response.end("synthetic-gateway-ok");
      return;
    }
    let raw = "";
    try {
      for await (const chunk of request) raw += chunk;
    } catch {
      // Native clients can cancel an in-flight fixture request during shutdown.
      response.destroy();
      return;
    }
    let input;
    try {
      input = raw ? JSON.parse(raw) : {};
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const json = (value) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    };
    let sequence = 0;
    const event = (type, data) =>
      response.write(
        `event: ${type}\ndata: ${JSON.stringify(type.startsWith("response.") ? { ...data, sequence_number: sequence++ } : data)}\n\n`,
      );
    let planned;
    try {
      planned =
        request.url === "/v1/responses" ||
        request.url === "/v1/chat/completions" ||
        /^\/v1\/messages(?:\?|$)/.test(request.url)
          ? nativeTool(input, raw)
          : {};
    } catch (error) {
      console.error(error.message);
      response.writeHead(500);
      response.end("Synthetic tool schema unsupported");
      return;
    }
    const text = planned.answer ?? answer;
    if (request.url === "/v1/messages/count_tokens") {
      json({ input_tokens: 8 });
      return;
    }
    if (request.url === "/v1/models") {
      json({
        object: "list",
        data: [
          {
            id: "synthetic-acceptance-model",
            object: "model",
            owned_by: "fixture",
          },
        ],
      });
      return;
    }
    if (request.url === "/v1/responses") {
      const message = planned.tool
        ? {
            id: "fc_fixture",
            type: "function_call",
            status: "completed",
            call_id: planned.tool.id,
            name: planned.tool.name,
            arguments: planned.tool.arguments,
          }
        : {
            id: "msg_fixture",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
          };
      const result = {
        id: "resp_fixture",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: input.model,
        output: [message],
        usage,
        error: null,
      };
      if (!input.stream) {
        json(result);
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      event("response.created", {
        type: "response.created",
        response: { ...result, status: "in_progress", output: [] },
      });
      event("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: planned.tool
          ? { ...message, status: "in_progress", arguments: "" }
          : { ...message, status: "in_progress", content: [] },
      });
      if (planned.tool) {
        event("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: message.id,
          output_index: 0,
          delta: planned.tool.arguments,
        });
        event("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: message.id,
          output_index: 0,
          name: planned.tool.name,
          arguments: planned.tool.arguments,
        });
      } else {
        event("response.content_part.added", {
          type: "response.content_part.added",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        event("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          delta: text,
        });
        event("response.output_text.done", {
          type: "response.output_text.done",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          text,
        });
        event("response.content_part.done", {
          type: "response.content_part.done",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          part: message.content[0],
        });
      }
      event("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: message,
      });
      event("response.completed", {
        type: "response.completed",
        response: result,
      });
      response.end();
      return;
    }
    if (
      request.url === "/v1/messages" ||
      request.url?.startsWith("/v1/messages?")
    ) {
      const message = {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: input.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 0 },
      };
      if (!input.stream) {
        json({
          ...message,
          content: planned.tool
            ? [
                {
                  type: "tool_use",
                  id: planned.tool.id,
                  name: planned.tool.name,
                  input: JSON.parse(planned.tool.arguments),
                },
              ]
            : [{ type: "text", text }],
          stop_reason: planned.tool ? "tool_use" : "end_turn",
          usage,
        });
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      event("message_start", { type: "message_start", message });
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: planned.tool
          ? {
              type: "tool_use",
              id: planned.tool.id,
              name: planned.tool.name,
              input: {},
            }
          : { type: "text", text: "" },
      });
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: planned.tool
          ? { type: "input_json_delta", partial_json: planned.tool.arguments }
          : { type: "text_delta", text },
      });
      event("content_block_stop", { type: "content_block_stop", index: 0 });
      event("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: planned.tool ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 4 },
      });
      event("message_stop", { type: "message_stop" });
      response.end();
      return;
    }
    if (request.url === "/v1/chat/completions") {
      const base = {
        id: "chatcmpl_fixture",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: input.model,
      };
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write(
        "data: " +
          JSON.stringify({
            ...base,
            choices: [
              {
                index: 0,
                delta: planned.tool
                  ? {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: planned.tool.id,
                          type: "function",
                          function: {
                            name: planned.tool.name,
                            arguments: planned.tool.arguments,
                          },
                        },
                      ],
                    }
                  : { role: "assistant", content: text },
                finish_reason: null,
              },
            ],
          }) +
          "\n\n",
      );
      response.write(
        "data: " +
          JSON.stringify({
            ...base,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: planned.tool ? "tool_calls" : "stop",
              },
            ],
            usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
          }) +
          "\n\n",
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    console.error(
      "Unexpected synthetic fixture route:",
      request.method,
      request.url,
    );
    response.writeHead(404);
    response.end("Synthetic fixture route unavailable");
  })
  .listen(4100, "0.0.0.0");
