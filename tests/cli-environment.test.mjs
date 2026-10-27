import test from 'node:test';
import assert from 'node:assert/strict';
import { cliEnvironment, setSystemProxyResolver } from '../src/core/cli-environment.mjs';
import { resolveLocalCli } from '../src/core/local-cli.mjs';
import { runProcess } from '../src/core/codex-cli.mjs';

test('native CLI child receives the configured system proxy while explicit overrides stay intact', async () => {
  const seen=[];
  setSystemProxyResolver(async url=>{seen.push(url);return 'PROXY 127.0.0.1:18081; DIRECT';});
  try {
    const source={...process.env};
    for(const key of Object.keys(source))if(/^(https?_proxy|all_proxy)$/i.test(key))delete source[key];
    const launch=await resolveLocalCli({kind:'codex',path:process.execPath},source);
    const actual=await runProcess(launch.executable,['-e','process.stdout.write(JSON.stringify({http:process.env.HTTP_PROXY,https:process.env.HTTPS_PROXY}))'],{env:launch.env});
    assert.deepEqual(JSON.parse(actual),{http:'http://127.0.0.1:18081',https:'http://127.0.0.1:18081'});
    assert.deepEqual(seen,['https://chatgpt.com']);
    const explicit=await cliEnvironment('claude',{https_proxy:'http://user.example:8080',NO_PROXY:'localhost'});
    assert.equal(explicit.https_proxy,'http://user.example:8080');assert.equal(explicit.HTTPS_PROXY,undefined);assert.equal(explicit.NO_PROXY,'localhost');
    assert.equal(seen.length,1);
    setSystemProxyResolver(async()=> 'DIRECT');assert.equal((await cliEnvironment('claude',{})).HTTPS_PROXY,undefined);
    setSystemProxyResolver(async()=> 'PROXY invalid:99999');assert.equal((await cliEnvironment('codex',{})).HTTPS_PROXY,undefined);
  }finally{setSystemProxyResolver(undefined);}
});
