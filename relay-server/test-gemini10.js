const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, line) => {
    const [k, ...v] = line.split('=');
    if (k && v) acc[k.trim()] = v.join('=').trim();
    return acc;
}, {});
const apiKey = env.BOT_API_KEY;
const body = {
    model: "gemini-2.5-flash",
    messages: [
        { role: "user", content: "list the contents of C:\WINDOWS" }
    ],
    tools: [
        { type: "function", function: { name: "list_directory", description: "List dir", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }
    ]
};
fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
    body: JSON.stringify(body)
}).then(r => r.json()).then(r => console.log(JSON.stringify(r.choices[0], null, 2))).catch(console.error);
