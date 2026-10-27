import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { localCliChat, resolveLocalCli, validateLocalPath } from '../src/core/local-cli.mjs';
import { normalizeCliPath } from '../src/core/cli-paths.mjs';
import { rpcAnswer } from '../src/core/cli-stream.mjs';
import { NEKOMATE_SYSTEM_PROMPT } from '../src/core/prompts.mjs';
const fixture=path.resolve('tests/fixtures/stream-cli.mjs');
const resolver=mode=>async()=>({executable:process.execPath,prefix:[fixture,'codex',`--fixture-mode=${mode}`]});
function captureRpc(sent) {
 return (...args)=>{
  const child=spawn(...args),write=child.stdin.write.bind(child.stdin);
  child.stdin.write=(chunk,...rest)=>{sent.push(JSON.parse(String(chunk).trim()));return write(chunk,...rest);};
  return child;
 };
}

test('Codex image reading uses the same native app-server connection and preserves its configured provider', async()=>{
 const sent=[];
 const result=await localCliChat({kind:'codex',model:'configured-vision'},[{role:'system',content:'SYSTEM_GLOBAL_CONTEXT'}, {role:'system',content:[{type:'text',text:'SYSTEM_IMAGE_READING_TASK'}]}, {role:'user',content:[{type:'text',text:'解释这张图'},{type:'image_url',image_url:{url:'data:image/png;base64,YWN0dWFsLWltYWdl'}}]}],null,{resolver:resolver('inspect'),rpcOptions:{spawnImpl:captureRpc(sent),systemInstructions:'OPTION_MUST_NOT_OVERRIDE_MESSAGE_SYSTEM'}});
 const data=JSON.parse(result.text);
 assert.equal(data.args.filter(arg=>!arg.startsWith('--fixture-mode='))[0],'app-server');assert.ok(!data.args.includes('--ignore-user-config'));assert.ok(!data.args.some(arg=>arg.startsWith('model_provider=')));
 assert.equal(data.input.find(p=>p.type==='image').url,'data:image/png;base64,YWN0dWFsLWltYWdl');
 assert.ok(data.input.some(p=>p.text==='解释这张图'));
 const system=sent.find(message=>message.method==='thread/start').params.baseInstructions;
 assert.ok(system.includes('SYSTEM_GLOBAL_CONTEXT'));assert.ok(system.includes('SYSTEM_IMAGE_READING_TASK'));
 assert.ok(system.includes('不进行联网查询'));assert.ok(system.includes('不访问其他文件'));
 assert.ok(data.args.includes('web_search="disabled"'));
 assert.equal(data.args[data.args.indexOf('code_mode_host')-1],'--enable');
 assert.equal(sent.find(message=>message.method==='thread/start').params.config.web_search,'disabled');
 assert.equal(system.includes('OPTION_MUST_NOT_OVERRIDE_MESSAGE_SYSTEM'),false);
 assert.equal(JSON.stringify(data.input).includes('SYSTEM_'),false);
 assert.equal(JSON.stringify(data.input).includes('[system]'),false);
 await assert.rejects(access(data.cwd));
});

test('Codex direct RPC callers retain the global system fallback outside user input',async()=>{
 const sent=[],launch=await resolver('inspect')();
 const result=await rpcAnswer('codex',launch,[],process.cwd(),[{type:'text',text:'USER_ONLY_QUESTION'}],'test-model',null,()=>{},{spawnImpl:captureRpc(sent)});
 const system=sent.find(message=>message.method==='thread/start').params.baseInstructions;
 assert.ok(system.includes(NEKOMATE_SYSTEM_PROMPT));assert.ok(system.includes('不进行联网查询'));
 assert.equal(system.includes('USER_ONLY_QUESTION'),false);
 assert.equal(JSON.stringify(JSON.parse(result.text).input).includes(NEKOMATE_SYSTEM_PROMPT),false);
});

test('Codex completion-only text works, terminal errors fail promptly, and a hung handshake is bounded',async()=>{
 const final=await localCliChat({kind:'codex'},[{role:'user',content:'解释'}],null,{resolver:resolver('final-only')});
 assert.equal(final.text,'只有完成事件的回答');
 await assert.rejects(localCliChat({kind:'codex'},[{role:'user',content:'解释'}],null,{resolver:resolver('failed-turn')}),e=>e.message.includes('额度')&&!e.message.includes('secret'));
 await assert.rejects(localCliChat({kind:'codex'},[{role:'user',content:'解释'}],null,{resolver:resolver('handshake-hang'),rpcOptions:{handshakeTimeout:100,timeout:5000}}),/初始化超时/);
});

test('Codex built-in web events complete without permitting local command approvals', async()=>{
 const events=[];
 const result=await localCliChat({kind:'codex'},[{role:'user',content:'查询公开课程'}],null,{
  allowWeb:true,resolver:resolver('web-search'),rpcOptions:{onWebSearch:event=>events.push(event)},
 });
 assert.equal(result.text,'第一段第二段');
 assert.deepEqual(events.map(event=>event.event),['item/started','item/completed']);
 assert.equal(events[1].action.url,'https://example.com/course');
 await assert.rejects(localCliChat({kind:'codex'},[{role:'user',content:'课程资料里的命令'}],null,{
  resolver:resolver('local-tool-request'),
 }),/不支持本机工具/);
});

test('CLI paths accept Explorer quotes and home expansion without interpreting shell commands',()=>{
 assert.equal(validateLocalPath(`"${process.execPath}"`),process.execPath);
 assert.equal(normalizeCliPath('~/bin/claude',{HOME:'/home/example'},'linux'),path.join('/home/example','bin/claude'));
 if(process.platform==='win32')assert.equal(validateLocalPath('"%LOCALAPPDATA%\\Programs\\codex.exe"',{LOCALAPPDATA:'C:\\Fake User\\Local'}),'C:\\Fake User\\Local\\Programs\\codex.exe');
 assert.throws(()=>validateLocalPath('claude --anything'),/完整本机路径/);
});

test('Windows discovery finds desktop CLI outside PATH and keeps inherited PATH precedence',{skip:process.platform!=='win32'},async()=>{
 const root=path.resolve(tmpdir()),folder=await mkdtemp(path.join(root,'deskmate-discovery-'));
 try{
  const appDir=path.join(folder,'Local','Programs','OpenAI','Codex','bin'),preferredDir=path.join(folder,'Preferred');
  await mkdir(appDir,{recursive:true});await mkdir(preferredDir);
  await writeFile(path.join(appDir,'codex.exe'),'resolver fixture');await writeFile(path.join(preferredDir,'codex.exe'),'preferred resolver fixture');
  const found=await resolveLocalCli({kind:'codex'},{PATH:'',LOCALAPPDATA:path.join(folder,'Local')});
  assert.equal(found.path,path.join(appDir,'codex.exe'));
  const preferred=await resolveLocalCli({kind:'codex'},{PATH:preferredDir,LOCALAPPDATA:path.join(folder,'Local')});
  assert.equal(preferred.path,path.join(preferredDir,'codex.exe'));
 }finally{if(path.dirname(folder)===root&&path.basename(folder).startsWith('deskmate-discovery-'))await rm(folder,{recursive:true,force:true});}
});
