import readline from 'node:readline';
const scenario=process.argv[2],mode=process.argv[3];
for await(const line of readline.createInterface({input:process.stdin})){
 const message=JSON.parse(line);
 if(scenario==='hang')continue;
 if(scenario==='fallback'&&mode==='gpu'){console.log(JSON.stringify({id:message.id,error:'gpu-unavailable'}));continue;}
 if(message.kind==='warmup'){await new Promise(resolve=>setTimeout(resolve,80));console.log(JSON.stringify({id:message.id,result:{warmed:true,mode}}));continue;}
 const wave=Buffer.from(message.audio,'base64');
 console.log(JSON.stringify({id:message.id,result:{text:'测试转写',source:'local',model:'Qwen3-ASR 0.6B '+mode.toUpperCase(),mode,segments:[],inputBytes:wave.length}}));
}
