import subprocess, json, sys, time, os
tmp = sys.argv[1]
env = dict(os.environ); env["ANTHROPIC_MODEL"] = "glm-5.3-flash:cloud"
proc = subprocess.Popen(["npx","--yes","@agentclientprotocol/claude-agent-acp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=tmp, text=True, bufsize=1, env=env)
def send(o): proc.stdin.write(json.dumps(o)+"\n"); proc.stdin.flush()
send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":True,"writeTextFile":True},"terminal":False,"auth":{"_meta":{"gateway":True}}},"clientInfo":{"name":"bandit","version":"0.1.0"}}})
proc.stdout.readline()
send({"jsonrpc":"2.0","id":8,"method":"authenticate","params":{"methodId":"gateway","_meta":{"gateway":{"baseUrl":"http://localhost:11434","headers":{"x-api-key":"ollama"}}}}})
while True:
    line = proc.stdout.readline()
    if not line: break
    m = json.loads(line)
    if m.get("id")==8: print("AUTH ok", flush=True); break
send({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":tmp,"mcpServers":[]}})
sid=None; full=None
while True:
    line = proc.stdout.readline()
    if not line: break
    m = json.loads(line)
    if m.get("id")==2: sid=m["result"]["sessionId"]; full=m; break
for o in (full["result"].get("configOptions") or []):
    if o.get("id")=="model": print("MODEL_OPTS:", [x["value"] for x in o["options"]][:6], "| current:", o.get("currentValue"), flush=True)
send({"jsonrpc":"2.0","id":5,"method":"session/set_mode","params":{"sessionId":sid,"modeId":"acceptEdits"}})
time.sleep(1)
send({"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":sid,"prompt":[{"type":"text","text":"Write hello.txt containing exactly HELLO_WORLD (use the file write tool). Then reply DONE."}]}})
while True:
    line = proc.stdout.readline()
    if not line: break
    try: m = json.loads(line)
    except: continue
    if m.get("method") == "session/update":
        u = m["params"]["update"]; t = u.get("sessionUpdate")
        if t == "agent_message_chunk":
            c = u.get("content"); blocks = c if isinstance(c, list) else [c]
            for b in blocks:
                if isinstance(b, dict) and b.get("type") == "text": print("CHUNK:", b.get("text","")[:110], flush=True)
        elif t == "tool_call": print("TOOL:", str(u.get("title",""))[:70], u.get("status",""), flush=True)
    if m.get("id") == 3:
        print("STOP:", m.get("result",{}).get("stopReason"), "| err:", str(m.get("error"))[:100], flush=True); break
proc.kill()
