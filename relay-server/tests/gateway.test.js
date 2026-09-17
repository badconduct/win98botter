"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const test = require("node:test");
const LLMClient = require("../agent/llm");

test("gateway profile and secret-file token preserve the existing tool-result loop", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "botter-gateway-"));
  const tokenFile = path.join(directory, "client-token");
  fs.writeFileSync(tokenFile, "synthetic-test-token\n");
  const previous = Object.fromEntries(["BOT_API_KEY_FILE", "BOT_AI_PROFILE", "BOT_MANAGED_API_URL"].map(k => [k,process.env[k]]));
  process.env.BOT_API_KEY_FILE = tokenFile;
  process.env.BOT_AI_PROFILE = "win98botter-test";
  t.after(() => {
    for (const [key,value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key]=value;
    }
    fs.rmSync(directory,{recursive:true,force:true});
  });
  const requests = [];
  const server = http.createServer(async (req,res) => {
    let text="";
    for await (const chunk of req) text+=chunk;
    requests.push({url:req.url,headers:req.headers,body:JSON.parse(text)});
    const first=requests.length===1;
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({choices:[{finish_reason:first?"tool_calls":"stop",message:first?
      {role:"assistant",content:null,tool_calls:[{id:"call_1",type:"function",function:{name:"get_system_info",arguments:"{}"}}]}:
      {role:"assistant",content:"Windows 98 detected."}}],usage:{prompt_tokens:10,completion_tokens:5}}));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  process.env.BOT_MANAGED_API_URL = `http://127.0.0.1:${server.address().port}/v1`;
  const client=new LLMClient(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,"stale-ui-key","default");
  assert.throws(()=>new LLMClient("https://untrusted.invalid/v1", "", "default"), /BOT_MANAGED_API_URL/);
  assert.throws(()=>client.configure("https://untrusted.invalid/v1", "", "default"), /BOT_MANAGED_API_URL/);
  assert.equal(client.apiUrl, process.env.BOT_MANAGED_API_URL);
  const tools=[{type:"function",function:{name:"get_system_info",parameters:{type:"object",properties:{}}}}];
  const history=[{role:"user",content:"Inspect the selected machine."}];
  const first=await client.call(history,tools,"Be concise.");
  assert.equal(first.stop_reason,"tool_use");
  assert.deepEqual(first.tool_calls,[{id:"call_1",name:"get_system_info",input:{}}]);
  const second=await client.call([...history,first._openai_message,{role:"tool",tool_call_id:"call_1",content:'{"os":"Windows 98"}'}],tools,"Be concise.");
  assert.equal(second.text,"Windows 98 detected.");
  assert.equal(requests.length,2);
  for (const request of requests) {
    assert.equal(request.url,"/v1/chat/completions");
    assert.equal(request.headers.authorization,"Bearer synthetic-test-token");
    assert.equal(request.headers["x-ai-profile"],"win98botter-test");
    assert.equal(request.body.model,"default");
    assert.equal(request.body.tools[0].function.name,"get_system_info");
  }
  assert.equal(requests[1].body.messages.at(-1).tool_call_id,"call_1");
  fs.writeFileSync(tokenFile, "\n");
  assert.throws(()=>new LLMClient(process.env.BOT_MANAGED_API_URL,"fallback","default"),/nonempty token/);
  fs.unlinkSync(tokenFile);
  assert.throws(()=>new LLMClient(process.env.BOT_MANAGED_API_URL,"fallback","default"),/ENOENT/);
});
