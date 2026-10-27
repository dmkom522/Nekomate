import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fastModeOption } from '../src/core/fast-capabilities.mjs';
import { catalogModels } from '../src/core/cli-models.mjs';
import { normalizeConfig, publicConfig, answerQuestion, analyzeFrame } from '../src/core/provider.mjs';
import { localCliChat } from '../src/core/local-cli.mjs';

test('fast capability uses Codex tiers, rejects ultrafast-only/unknown entries, and respects exclusions', () => {
  const cli={mode:'cli',kind:'codex'};
  assert.deepEqual(fastModeOption({serviceTiers:[{id:'priority',name:'Fast'}]},cli),{type:'codex',tier:'priority'});
  assert.equal(fastModeOption({id:'gpt-5.6-terra'},cli),null);
  assert.equal(fastModeOption({serviceTiers:[{id:'ultrafast',name:'Ultrafast'}]},cli),null);
  assert.equal(fastModeOption({supportsFastMode:false,serviceTiers:['priority']},cli),null);
  const rows=catalogModels([{id:'gpt-5.6-terra',inputModalities:['image'],serviceTiers:[{id:'priority',name:'Fast'}]}]);
  assert.equal(rows[0].fastMode.tier,'priority');
  assert.equal(fastModeOption({id:'gpt-6-astra'},{baseUrl:'https://api.openai.com/v1'}).tier,'priority');
  assert.equal(fastModeOption({id:'gpt-6-astra'},{baseUrl:'https://gateway.example/v1'}),null);
  assert.equal(fastModeOption({id:'gpt-6-astra',service_tiers:[]},{baseUrl:'https://api.openai.com/v1'}),null);
  assert.equal(fastModeOption({id:'deepseek-flash'},{baseUrl:'https://api.deepseek.com'}),null);
  assert.equal(fastModeOption({id:'opus'},{mode:'cli',kind:'claude'}),null);
  assert.equal(fastModeOption({id:'opus',supportsFastMode:true},{mode:'cli',kind:'claude'}).type,'claude');
});

test('fast choice defaults off, persists only for the same connection/model, and rejects invalid values',()=>{
  const initial=normalizeConfig({mode:'api',vision:{baseUrl:'https://example.com/v1',model:'vision',apiKey:'secret'}});
  assert.equal(initial.fastMode,false);
  const enabled=normalizeConfig({fastMode:true},initial);assert.equal(publicConfig(enabled).fastMode,true);
  assert.equal(normalizeConfig({},enabled).fastMode,true);
  for(const vision of [{model:'other'},{baseUrl:'https://other.example/v1'},{apiKey:'different'}])assert.equal(normalizeConfig({vision},enabled).fastMode,false);
  const cli=normalizeConfig({mode:'cli',cli:{kind:'codex',model:'first'},fastMode:true});
  assert.equal(normalizeConfig({cli:{model:'second'}},cli).fastMode,false);
  assert.equal(normalizeConfig({cli:{kind:'claude'}},cli).fastMode,false);
  assert.throws(()=>normalizeConfig({fastMode:'true'},initial),/快速模式/);
});

for(const protocol of ['openai','anthropic'])test(`${protocol} real HTTP requests enable fast only for answers; notes remain ordinary and unsupported models fail`,async()=>{
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.method==='GET'){res.end(JSON.stringify({data:[
      {id:'fast-vision',input_modalities:['image'],...(protocol==='openai'?{service_tiers:['default','priority']}:{capabilities:{fast_mode:{supported:true}}})},
      {id:'ordinary-vision',input_modalities:['image']},
    ]}));return;}
    let text='';for await(const chunk of req)text+=chunk;
    requests.push({body:JSON.parse(text),headers:req.headers});
    res.end(JSON.stringify(protocol==='anthropic'?{content:[{type:'text',text:'fixture'}],stop_reason:'end_turn'}:{choices:[{message:{content:'fixture'},finish_reason:'stop'}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const config=normalizeConfig({fastMode:true,vision:{provider:'custom',protocol,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fast-vision'}});
    const image='data:image/png;base64,YQ==';
    await answerQuestion(config,{question:'explain',frames:[{time:1,image}]});
    const sent=requests[0];
    if(protocol==='openai')assert.equal(sent.body.service_tier,'priority');
    else{assert.equal(sent.body.speed,'fast');assert.equal(sent.headers['anthropic-beta'],'fast-mode-2026-02-01');}
    assert.ok(JSON.stringify(sent.body).includes('explain'));assert.ok(JSON.stringify(sent.body).includes('YQ=='));
    await analyzeFrame(config,{frame:{time:2,image},source:'fixture',previous:[]});
    assert.equal(requests[1].body.service_tier,undefined);assert.equal(requests[1].body.speed,undefined);
    const disabled={...config,fastMode:false};await answerQuestion(disabled,{question:'ordinary'});
    assert.equal(requests[2].body.service_tier,undefined);assert.equal(requests[2].body.speed,undefined);
    await assert.rejects(answerQuestion({...config,vision:{...config.vision,model:'ordinary-vision'}},{question:'unsupported'}),/未确认支持快速/);
    assert.equal(requests.length,3);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('Claude current fast models use documented preview headers only where needed',()=>{
  const config={protocol:'anthropic',baseUrl:'https://api.anthropic.com/v1'};
  assert.equal(fastModeOption({id:'claude-opus-5-5'},config).beta,undefined);
  assert.equal(fastModeOption({id:'claude-opus-5'},config).beta,'fast-mode-2026-02-01');
  assert.equal(fastModeOption({id:'claude-opus-4-7'},config),null);
  assert.equal(fastModeOption({id:'claude-sonnet-5'},config),null);
});

test('Codex forwards the requested tier on both thread and turn, and Claude isolates its fast flag in session settings',async()=>{
  for(const enabled of [true,false]){
    const sent=[];
    const result=await localCliChat({kind:'codex',model:'fixture-model'},[{role:'user',content:'fixture'}],null,{
      resolver:async()=>({executable:process.execPath,prefix:[path.resolve('tests/fixtures/stream-cli.mjs'),'codex','--fixture-mode=inspect']}),
      fastMode:enabled?{type:'codex',tier:'priority'}:null,
      rpcOptions:{spawnImpl:(...args)=>{const child=spawn(...args),write=child.stdin.write.bind(child.stdin);child.stdin.write=(chunk,...rest)=>{sent.push(JSON.parse(String(chunk)));return write(chunk,...rest);};return child;}},
    });
    assert.ok(result.text);
    for(const method of ['thread/start','turn/start'])assert.equal(sent.find(r=>r.method===method).params.serviceTier,enabled?'priority':'default');
    const decoded=JSON.parse(result.text);assert.equal(decoded.args.includes('fast_mode'),enabled);
    const claude=await localCliChat({kind:'claude',model:'claude-opus-5-5'},[{role:'user',content:'fixture'}],null,{
      resolver:async()=>({executable:process.execPath,prefix:[path.resolve('tests/fixtures/local-cli.mjs'),'claude']}),
      fastMode:enabled?{type:'claude'}:null,
    });
    const args=JSON.parse(claude.text).args,settings=JSON.parse(args[args.indexOf('--settings')+1]);
    assert.equal(settings.fastMode,enabled);assert.equal(settings.disableAllHooks,true);
  }
});
