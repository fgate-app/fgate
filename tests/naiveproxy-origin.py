"""Private deterministic origin and process metrics for FG-15.1."""
import hashlib,json,os,pathlib,signal,subprocess,sys,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
root=pathlib.Path(sys.argv[1]);children={};payload=bytes(range(256))*16384;digest=hashlib.sha256(payload).hexdigest()
def metrics(pid):
 stat=pathlib.Path(f'/proc/{pid}/stat').read_text().split();status=pathlib.Path(f'/proc/{pid}/status').read_text().splitlines();rss=next(int(s.split()[1]) for s in status if s.startswith('VmRSS:'))
 return {'cpuSeconds':(int(stat[13])+int(stat[14]))/os.sysconf('SC_CLK_TCK'),'rssKiB':rss}
class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args):pass
 def respond(self,data,status=200):
  self.send_response(status);self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
 def do_GET(self):
  if self.path=='/health':self.respond(b'ok')
  elif self.path=='/blob':self.respond(payload)
  elif self.path=='/metrics':self.respond(json.dumps({name:metrics(child.pid) for name,child in children.items()}).encode())
  else:self.respond(b'not found',404)
 def do_POST(self):
  length=int(self.headers.get('Content-Length','0'))
  if self.path!='/upload' or length!=len(payload):self.respond(b'invalid length',400);return
  data=self.rfile.read(length);ok=hashlib.sha256(data).hexdigest()==digest;self.respond(json.dumps({'verified':ok,'bytes':len(data)}).encode(),200 if ok else 400)
server=ThreadingHTTPServer(('127.0.0.1',18445),Handler)
try:
 for name,args in [('naive',[str(root/'caddy'),'run','--adapter','caddyfile','--config',str(root/'Caddyfile')]),('vless',[str(root/'xray'),'run','-c',str(root/'xray.json')])]:
  log=(root/(name+'.log')).open('wb');children[name]=subprocess.Popen(args,stdout=log,stderr=log,cwd=root);log.close()
 (root/'pids.json').write_text(json.dumps({name:child.pid for name,child in children.items()}))
 server.serve_forever()
finally:
 for child in children.values():
  child.terminate()
  try:child.wait(timeout=3)
  except subprocess.TimeoutExpired:child.kill();child.wait()
