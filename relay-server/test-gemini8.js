require('dotenv').config();
const apiKey = process.env.BOT_API_KEY;
const body = {
    model: "gemini-3.1-flash-lite-preview",
    messages: [
        { role: "user", content: "hello, use the grep_file tool to look for XYZ" }
    ],
    tools: [
        { type: "function", function: { name: "default_api:grep_file", description: "test", parameters: { type: "object", properties: {}, required: [] } } }
    ]
};
fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
    body: JSON.stringify(body)
}).then(r => r.json()).then(r => console.log(JSON.stringify(r, null, 2))).catch(console.error);
