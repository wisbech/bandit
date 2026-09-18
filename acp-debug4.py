import subprocess, json, sys, time
tmp = sys.argv[1]
proc = subprocess.Popen(["npx","--yes","@agentclientprotocol/claude-agent-acp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=tmp, text=True, bufsize=1)
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
    if o.get("id")=="model":
        print(json.dumps(o, indent=1)[:900], flush=True)
proc.kill()
