const fs = require('fs');
const env = JSON.parse(fs.readFileSync('../data/relay-config.json', 'utf8'));
const apiKey = env.BOT_API_KEY;
const body = {
    model: "gemini-3.1-flash-lite-preview",
    messages: [
        { role: "user", content: "hello, use the grep_file tool to look for XYZ" },
        {
          role: "assistant",
          tool_calls: [{
             id: "call_123",
             type: "function",
             function: {
                name: "default_api:grep_file",
                arguments: "{}"
             }
          }]
        },
        { role: "tool", tool_call_id: "call_123", content: "ok" },
        { role: "user", content: "did you find it?" }
    ],
    tools: [
        { type: "function", function: { name: "default_api:grep_file", description: "test", parameters: { type: "object", properties: {}, required: [] } } }
    ]
};
fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
    body: JSON.stringify(body)
}).then(r => r.json()).then(r => console.log(JSON.stringify(r))).catch(console.error);
