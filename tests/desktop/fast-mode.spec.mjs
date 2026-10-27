import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

test('chat lightning toggles real request parameters, persists, and resets on unsupported/model changes',async()=>{
  test.setTimeout(45000);
  const requests=[];let hold=false,release;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.method==='GET'){res.end(JSON.stringify({data:[
      {id:'fast-fixture',display_name:'支持快速模式',input_modalities:['image'],service_tiers:['default','priority']},
      {id:'plain-fixture',display_name:'普通模型',input_modalities:['image']},
    ]}));return;}
    let data='';for await(const chunk of req)data+=chunk;
    const body=JSON.parse(data);requests.push(body);
    if(hold){hold=false;await new Promise(resolve=>release=resolve);}
    if(body.stream){res.setHeader('content-type','text/event-stream');res.end(`data: ${JSON.stringify({choices:[{delta:{content:'fixture answer'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);return;}
    res.end(JSON.stringify({choices:[{message:{content:'fixture note'},finish_reason:'stop'}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const profile=await mkdtemp(path.resolve('.local/fast-mode-ui-'));
  const env={...process.env,DESKMATE_TEST_DIR:profile,AI_MODE:'api',VISION_PROVIDER:'custom',VISION_PROTOCOL:'openai',VISION_MODEL:'fast-fixture',VISION_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`,VISION_API_KEY:''};delete env.ELECTRON_RUN_AS_NODE;
  let app;
  async function launch(){
    app=await electron.launch({args:['.'],env,executablePath:process.env.DESKMATE_ELECTRON_PATH});
    await expect.poll(()=>app.windows().some(p=>p.url().endsWith('/index.html'))).toBe(true);
    const page=app.windows().find(p=>p.url().endsWith('/index.html'));
    await page.waitForFunction(()=>typeof document.getElementById('chatFastMode').onclick==='function');
    await app.evaluate(({BrowserWindow})=>{const main=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'));main.show();main.webContents.send('panel:page','chat');});
    await expect(page.locator('#chatFastMode')).toBeVisible();return page;
  }
  try{
    let page=await launch();
    const fast=page.locator('#chatFastMode');await expect(fast).toHaveAttribute('aria-pressed','false');
    await expect(fast).toHaveAttribute('title',/额度消耗/);await fast.click();
    await expect(fast).toHaveAttribute('aria-pressed','true');
    expect((await page.evaluate(()=>window.deskmate.getSettings())).fastMode).toBe(true);
    await page.screenshot({path:'test-results/chat-fast-mode.png',fullPage:true});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).webContents.send('panel:page','bubble'));
    await expect(page.locator('body')).toHaveClass(/bubble/);
    const buttonBounds=await fast.boundingBox(),composerBounds=await page.locator('.composer').boundingBox();
    expect(buttonBounds.x).toBeGreaterThanOrEqual(composerBounds.x);expect(buttonBounds.x+buttonBounds.width).toBeLessThanOrEqual(composerBounds.x+composerBounds.width);
    await page.screenshot({path:'test-results/bubble-fast-mode.png',omitBackground:true});
    await app.close();app=null;page=await launch();
    await expect(page.locator('#chatFastMode')).toHaveAttribute('aria-pressed','true');
    const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fhsAAAAASUVORK5CYII=';
    await page.evaluate(async image=>{
      await window.deskmate.createSession('fast-ui-session');
      const note=await window.deskmate.analyze('fast-ui-note',{sessionId:'fast-ui-session',eventId:'fast-ui-note',frame:{time:1,image},source:'fixture'});
      const {SessionHistory}=await import('./session-history.mjs');const history=await SessionHistory.open();
      await history.save('fast-ui-session',{format:'deskmate-session',version:1,sessionInitialized:true,savedAt:new Date().toISOString(),elapsed:1,source:'fixture',frames:[],analyses:[{time:1,text:note.text,source:'fixture'}],transcripts:[],messages:[]});history.db.close();
    },image);
    expect(requests.at(-1).service_tier).toBeUndefined();
    await page.reload();await page.waitForFunction(()=>typeof document.getElementById('chatFastMode').onclick==='function');
    await expect(page.locator('#chatFastMode')).toBeVisible();
    await expect(page.locator('#chatFastMode')).toBeEnabled();
    hold=true;await page.locator('#question').fill('check fast answer');await page.locator('#sendBtn').click();
    await expect.poll(()=>requests.some(r=>r.stream&&r.service_tier==='priority')).toBe(true);
    await expect(page.locator('#chatFastMode')).toBeDisabled();
    await expect(page.locator('#chatModel')).toBeDisabled();release();
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await page.locator('#chatFastMode').click();await expect(page.locator('#chatFastMode')).toHaveAttribute('aria-pressed','false');
    await page.locator('#question').fill('check normal answer');await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toHaveCount(2);expect(requests.at(-1).service_tier).toBeUndefined();
    await page.locator('#chatFastMode').click();await expect(page.locator('#chatFastMode')).toHaveAttribute('aria-pressed','true');
    await page.locator('#chatModel').selectOption('plain-fixture');
    await expect(page.locator('#chatFastMode')).toBeHidden();expect((await page.evaluate(()=>window.deskmate.getSettings())).fastMode).toBe(false);
    const invalid=await page.evaluate(()=>window.deskmate.saveSettings({fastMode:true}).then(()=>'',e=>e.message));expect(invalid).toContain('未确认支持快速模式');
    await page.locator('#chatModel').selectOption('fast-fixture');
    await expect(page.locator('#chatFastMode')).toBeVisible();await expect(page.locator('#chatFastMode')).toHaveAttribute('aria-pressed','false');
  }finally{release?.();await app?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
