import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, copyFile, rename, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SPEECH_FILES } from '../src/core/speech-assets.mjs';
import { prepareQwenEngine, QWEN_SOURCE } from './prepare-qwen-engine.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const destination=path.join(root,'.local/qwen-speech'),cache=path.join(root,'.local/qwen-downloads'),benchmark=path.join(root,'.local/qwen-benchmark');
const run=promisify(execFile);
if(process.platform==='darwin') { await import('./prepare-macos-speech.mjs');process.exit(0); }
if(process.platform!=='win32'||process.arch!=='x64') { console.log('Qwen bundled runtime currently targets Windows x64.');process.exit(0); }
async function digest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function valid(file,hash,bytes){try{return (!bytes||(await stat(file)).size===bytes)&&await digest(file)===hash;}catch{return false;}}
async function download(url,name,hash,seed,bytes){
 const file=path.join(cache,name);if(await valid(file,hash,bytes))return file;
 if(seed&&await valid(seed,hash,bytes)){await copyFile(seed,file);return file;}
 const partial=file+'.part';const proxy=process.env.NEKOMATE_DOWNLOAD_PROXY;
 try{await run('curl',['--fail','--location','--retry','3','--connect-timeout','20','--max-time','600',...(proxy?['--proxy',proxy]:[]),'--output',partial,url],{windowsHide:true,timeout:650000,maxBuffer:2e6});
 if(!await valid(partial,hash,bytes))throw new Error('Qwen download checksum failed: '+name);await rename(partial,file);return file;
 }finally{await rm(partial,{force:true});}
}
async function extract(archive,dir){await mkdir(dir,{recursive:true});await run('tar',['-xf',archive,'-C',dir],{windowsHide:true});}
async function walk(dir){const result=[];for(const item of await readdir(dir,{withFileTypes:true})){if(item.name==='__pycache__'||item.name.endsWith('.pyc'))continue;const file=path.join(dir,item.name);if(item.isDirectory())result.push(...await walk(file));else result.push(file);}return result;}
await mkdir(destination,{recursive:true});await mkdir(cache,{recursive:true});
let previous;try{previous=JSON.parse(await readFile(path.join(destination,'manifest.json'),'utf8'));}catch{}
const sameDependencies=JSON.stringify(previous?.wheels)===JSON.stringify(JSON.parse(await readFile(path.join(root,'scripts/qwen-wheels.json'),'utf8')));
let ready=sameDependencies&&Array.isArray(previous?.files)&&previous.files.length>100;
if(ready)for(const file of previous.files){if(!await valid(path.join(destination,file.path),file.sha256,file.bytes)){ready=false;break;}}
const wheels=JSON.parse(await readFile(path.join(root,'scripts/qwen-wheels.json'),'utf8'));
if(!ready){
 const py=await download('https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip','python-embed.zip','4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3',path.join(benchmark,'python-embed.zip'));
 await extract(py,path.join(destination,'python'));
 await writeFile(path.join(destination,'python/python312._pth'),'python312.zip\n.\n../packages\n../engine\nimport site\n');
 const model=await download('https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/download/models/Qwen3-ASR-0.6B-gguf.zip','qwen-0.6b.zip','3684b9cac9978a93c82ceeb93448bb5027c0b2beaf2e0affa35190ba20e545ff',path.join(benchmark,'model.zip'));
 const unpacked=path.join(cache,'model');await extract(model,unpacked);const contents=await walk(unpacked);await mkdir(path.join(destination,'model'),{recursive:true});
 for(const entry of SPEECH_FILES){const found=contents.find(file=>path.basename(file)===entry.name);if(!found||!await valid(found,entry.sha256,entry.bytes))throw new Error('Invalid Qwen model: '+entry.name);await copyFile(found,path.join(destination,'model',entry.name));}
 const native=await download('https://github.com/ggml-org/llama.cpp/releases/download/b11724/llama-b11724-bin-win-vulkan-x64.zip','llama-vulkan.zip','82984b2d1bf1c80f033021b6c5173238ad7712cda02c5155b4cbedf859db24ba',path.join(benchmark,'llama-vulkan.zip'));
 await extract(native,path.join(cache,'native'));const dlls=(await walk(path.join(cache,'native'))).filter(file=>/^(ggml(?!-rpc).*|llama|libomp)\.dll$/i.test(path.basename(file)));
 const bin=path.join(destination,'engine/qwen_asr_gguf/inference/bin');await mkdir(bin,{recursive:true});for(const dll of dlls)await copyFile(dll,path.join(bin,path.basename(dll)));
 for(const item of wheels){console.log('Preparing Qwen runtime:',item.name,item.version);const wheel=await download(item.url,item.file,item.sha256,null,item.bytes);await extract(wheel,path.join(destination,'packages'));}
}
await prepareQwenEngine({root,destination,download});
await copyFile(path.join(root,'src/native/qwen-worker.py'),path.join(destination,'worker.py'));
const files=[];for(const file of await walk(destination)){if(file===path.join(destination,'manifest.json'))continue;files.push({path:path.relative(destination,file).replaceAll('\\','/'),bytes:(await stat(file)).size,sha256:await digest(file)});}
await writeFile(path.join(destination,'manifest.json'),JSON.stringify({model:'Qwen3-ASR 0.6B INT4/Q4_K',sourceCommit:QWEN_SOURCE.commit,sourceArchive:QWEN_SOURCE,llama:'b11724',python:'3.12.10',wheels,files},null,2));
console.log('Qwen runtime and model ready; SHA-256 verified.');
