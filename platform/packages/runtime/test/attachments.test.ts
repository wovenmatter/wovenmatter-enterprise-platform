import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, rm, symlink, writeFile, link, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as unixConnect } from "node:net";
import { createHash } from "node:crypto";
import { MAX_ATTACHMENT_BYTES, MAX_INPUT_BYTES, validateAttachments, prepareAttachments, attachmentPrompt, attachmentToolText, openCodeFiles } from "../src/attachments.js";
import { MAX_PROMPT_BYTES, validateContainerRequest, validateInputText } from "../src/validation.js";
import { sessionBroker } from "../src/session-broker.js";

const file = (name = "note.txt", text = "Immutable note") => ({ name, mimeType: "text/plain", data: Buffer.from(text).toString("base64") });

async function withBrokerFixture(directory: string, upstream: Server,
  use: (broker: Awaited<ReturnType<typeof sessionBroker>>) => Promise<void>,
  startBroker = sessionBroker) {
  let broker: Awaited<ReturnType<typeof sessionBroker>> | undefined;
  // Cleanup covers both listener and privileged broker startup failures.
  try {
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });
    broker = await startBroker(directory, 'fixture-project', {});
    await use(broker);
  } finally {
    broker?.close();
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}

test("broker startup failure closes the upstream fixture before rejecting", async t => {
  const upstream = createServer();
  t.after(() => { upstream.closeAllConnections(); if (upstream.listening) upstream.close(); });
  await assert.rejects(withBrokerFixture('/unused-fixture', upstream, async () => {
    assert.fail('Failed startup must not invoke the transport fixture');
  }, async () => {
    assert.equal(upstream.listening, true);
    throw new Error('Synthetic ownership setup failure');
  }), /Synthetic ownership setup failure/);
  assert.equal(upstream.listening, false);
});

test("attachment admission rejects untrusted paths, malformed bytes, and desktop count/size overflow", () => {
  for (const invalid of [null, {}, Array.from({length:9},()=>file()), [{...file(),path:'/etc/passwd'}],
    [{...file(),data:'not base64'}], [{...file(),data:'AB=='}], [{...file(),name:'bad\nname'}],
    [{...file(),mimeType:'text/plain\r\nInjected: true'}], [{...file(),data:'A'.repeat(Math.ceil(MAX_ATTACHMENT_BYTES/3)*4+4)}]])
    assert.throws(()=>validateAttachments(invalid),{code:'invalid_attachment'});
  const image={name:'image.png',mimeType:'image/png',data:Buffer.alloc(1024*1024,7).toString('base64')};
  validateAttachments([image]);
  assert.ok(Buffer.byteLength(JSON.stringify({attachments:[image]}))>1024*1024,'Valid native input can exceed the event/output bound');
  assert.ok(Buffer.byteLength(JSON.stringify({attachments:[image]}))<MAX_INPUT_BYTES);
});

test("private attachment snapshots survive retry, repair altered copies, and reject link escapes",async t=>{
  const home=await mkdtemp(join(tmpdir(),'wme-attachment-home-'));
  const outside=await mkdtemp(join(tmpdir(),'wme-attachment-outside-'));
  t.after(()=>Promise.all([rm(home,{recursive:true,force:true}),rm(outside,{recursive:true,force:true})]));
  const input=[file('../../note.txt')];
  const first=await prepareAttachments(input,home);
  assert.ok(first[0].path.startsWith(home+'/attachments/'));
  assert.equal(await readFile(first[0].path,'utf8'),'Immutable note');
  await writeFile(first[0].path,'Changed by native tool');
  assert.equal((await prepareAttachments(input,home))[0].path,first[0].path);
  assert.equal(await readFile(first[0].path,'utf8'),'Immutable note');
  const secret=join(outside,'private.txt');await writeFile(secret,'Host fixture');
  await rm(first[0].path);await symlink(secret,first[0].path);
  await assert.rejects(prepareAttachments(input,home));
  assert.equal(await readFile(secret,'utf8'),'Host fixture');
  await rm(first[0].path);await link(secret,first[0].path);
  await assert.rejects(prepareAttachments(input,home),{code:'invalid_attachment'});
  assert.equal(await readFile(secret,'utf8'),'Host fixture');
});

test("desktop transport distinguishes image bytes, UTF-8 resource, binary link and Pi tool references",async t=>{
  const home=await mkdtemp(join(tmpdir(),'wme-attachment-contract-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const files=await prepareAttachments([
    {name:'photo.png',mimeType:'image/png',data:Buffer.from([137,80,78,71]).toString('base64')},
    file(),
    {name:'invalid-utf8.txt',mimeType:'text/plain',data:Buffer.from([255,254,255]).toString('base64')},
    {name:'report.pdf',mimeType:'application/pdf',data:Buffer.from('%PDF').toString('base64')},
  ],home);
  const blocks=attachmentPrompt('Inspect',files) as any[];
  assert.deepEqual(blocks.map(block=>block.type),['text','image','resource','resource_link','resource_link']);
  assert.equal(blocks[1].data,files[0].data);
  assert.equal(blocks[2].resource.text,'Immutable note');
  assert.equal(blocks[3].uri,files[2].uri);
  assert.ok(blocks[0].text.includes(files[3].path));
  const nativeFiles=openCodeFiles(files);
  assert.equal(nativeFiles[0].uri,'data:image/png;base64,'+files[0].data);
  assert.equal(nativeFiles[3].name,'report.pdf');
  const pi=attachmentToolText('Inspect',files);
  for(const file of files)assert.ok(pi.includes(file.path));
  assert.ok(!pi.includes(files[0].data),'Pi must not confuse encoded bytes with image support');
});

test("initial and steering text accept a large note snapshot and enforce UTF-8 byte bounds",()=>{
  const snapshot='n'.repeat(200_000);
  validateInputText(snapshot);
  validateInputText(snapshot,true);
  validateInputText('',true);
  validateInputText('a'.repeat(MAX_PROMPT_BYTES),true);
  for(const value of ['a'.repeat(MAX_PROMPT_BYTES+1),'é'.repeat(MAX_PROMPT_BYTES/2+1)]) {
    assert.throws(()=>validateInputText(value),{code:'invalid_request'});
    assert.throws(()=>validateInputText(value,true),{code:'invalid_request'});
  }
});

test("50 MiB immutable files cross trusted input, native image mapping and authenticated inference broker",async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wme-attachment-limit-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  // This is synthetic protocol transport, not a provider image-validity claim.
  const attachments=[0,1].map(index=>({name:`image-${index}.png`,mimeType:'image/png',data:Buffer.alloc(MAX_ATTACHMENT_BYTES,index+1).toString('base64')}));
  const input={runId:'large-files',projectId:'fixture-project',harness:'codex' as const,model:'fixture-model',prompt:'n'.repeat(200_000),access:'write' as const,workingDirectory:'/workspace',gateway:{baseUrl:'http://fixture.invalid/inference',token:'synthetic-limit-test-token'},attachments};
  const envelope=JSON.stringify({type:'turn',request:input});
  assert.ok(Buffer.byteLength(envelope)<MAX_INPUT_BYTES);
  validateContainerRequest(JSON.parse(envelope).request);
  const files=await prepareAttachments(input.attachments,directory);
  const body=JSON.stringify({messages:[{role:'user',content:attachmentPrompt(input.prompt,files)}]});
  const bytes=Buffer.byteLength(body),expected=createHash('sha256').update(body).digest('hex');
  assert.ok(bytes>50*1024*1024&&bytes<MAX_INPUT_BYTES);
  let received=0,digest='',calls=0;
  const upstream=createServer(async(req,res)=>{
    calls++;
    assert.equal(req.headers.authorization,'Bearer synthetic-upstream-grant');
    const hash=createHash('sha256');
    for await(const chunk of req){received+=chunk.length;hash.update(chunk);}
    digest=hash.digest('hex');res.end('{"ok":true}');
  });
  const brokerDirectory=join(directory,'broker'), socketPath=join(brokerDirectory,'gateway.sock');
  const uid=process.getuid!(), gid=process.getgid!(), chown=fs.chown;
  // The trusted broker runs as root in production. Unprivileged CI exercises
  // real transport/auth/limits with its own ownership; root runs keep the real
  // uid0/gid10001 ownership setup. This mock does not prove OS ownership.
  const ownership=uid===0?undefined:t.mock.method(fs,'chown',async(...args:Parameters<typeof fs.chown>)=>{
    assert.ok(args[0]===brokerDirectory||args[0]===socketPath,'Only this fixture ownership may be adapted');
    assert.deepEqual(args.slice(1),[0,10001]);
    await chown(args[0],uid,gid);
  });
  if(ownership)syncBuiltinESMExports();
  try {
    await withBrokerFixture(brokerDirectory,upstream,async broker=>{
    if(ownership)assert.equal(ownership.mock.callCount(),2);
    for(const [path,mode]of [[brokerDirectory,0o750],[socketPath,0o660]]as const){
      const actual=await stat(path);
      assert.equal(actual.uid,uid);assert.equal(actual.gid,uid===0?10001:gid);assert.equal(actual.mode&0o777,mode);
    }
    broker.setGateway({baseUrl:`http://127.0.0.1:${(upstream.address() as any).port}/inference`,token:'synthetic-upstream-grant'});
    const send=(authorization:string)=>new Promise<number>((resolve,reject)=>{
      const request=httpRequest({socketPath:join(directory,'broker/gateway.sock'),path:'/inference/v1/responses',method:'POST',headers:{authorization,'content-type':'application/json'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!));});
      request.on('error',reject);request.end(authorization.endsWith(broker.token)?body:'{}');
    });
    assert.equal(await send('Bearer wrong-capability'),403);
    assert.equal(calls,0);
    assert.equal(await send('Bearer '+broker.token),200);
    assert.equal(received,bytes);
    assert.equal(digest,expected);
    assert.equal(calls,1);
    assert.throws(()=>validateAttachments([...attachments,file('over.txt','x')]),{code:'invalid_attachment'});
    t.diagnostic(`Synthetic 50 MiB files: ${bytes} native JSON bytes; peak process RSS ${process.resourceUsage().maxRSS} KiB.`);
    });
  } finally {
    ownership?.mock.restore();
    if(ownership)syncBuiltinESMExports();
  }
});

test("session proxy advertises Basic challenges for browser HTTP and CONNECT without granting unauthenticated access",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"wme-browser-proxy-")),uid=process.getuid!(),gid=process.getgid!(),chown=fs.chown;
 const ownership=uid===0?undefined:t.mock.method(fs,"chown",async(...args:Parameters<typeof fs.chown>)=>{await chown(args[0],uid,gid);});if(ownership)syncBuiltinESMExports();
 const upstream=createServer((request,response)=>{assert.equal(request.headers["proxy-authorization"],"Basic "+Buffer.from("fixture-project:synthetic-upstream").toString("base64"));response.end("PROXY_OK");});
 let broker:Awaited<ReturnType<typeof sessionBroker>>|undefined;
 try{
  await new Promise<void>(resolve=>upstream.listen(0,"127.0.0.1",resolve));
  broker=await sessionBroker(directory,"fixture-project",{origin:"http://127.0.0.1:"+(upstream.address()as any).port,token:"synthetic-upstream"});
  const call=(authorization?:string)=>new Promise<{status:number;challenge:unknown;body:string}>((resolve,reject)=>{const request=httpRequest({socketPath:join(directory,"egress.sock"),path:"http://public.fixture.invalid/page",headers:authorization?{"proxy-authorization":authorization}:{}},response=>{let body="";response.on("data",chunk=>body+=chunk);response.on("end",()=>resolve({status:response.statusCode!,challenge:response.headers["proxy-authenticate"],body}));});request.once("error",reject);request.end();});
  const denied=await call();assert.equal(denied.status,407);assert.equal(denied.challenge,'Basic realm="workspace"');assert.equal(denied.body,"");
  const allowed=await call("Basic "+Buffer.from("fixture-project:"+broker.token).toString("base64"));assert.equal(allowed.status,200);assert.equal(allowed.body,"PROXY_OK");
  const connect=await new Promise<string>((resolve,reject)=>{const socket=unixConnect(join(directory,"egress.sock"));let text="";socket.once("connect",()=>socket.write("CONNECT public.fixture.invalid:443 HTTP/1.1\r\nHost: public.fixture.invalid:443\r\n\r\n"));socket.on("data",chunk=>text+=chunk);socket.once("end",()=>resolve(text));socket.once("error",reject);});
  assert.match(connect,/^HTTP\/1.1 407/);assert.match(connect,/Proxy-Authenticate: Basic realm="workspace"/);
 }finally{broker?.close();upstream.closeAllConnections();if(upstream.listening)await new Promise<void>(resolve=>upstream.close(()=>resolve()));await rm(directory,{recursive:true,force:true});ownership?.mock.restore();if(ownership)syncBuiltinESMExports();}
});
