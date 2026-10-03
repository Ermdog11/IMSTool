const { chromium } = require('playwright');const { spawn } = require('child_process');
const FPS=24, OUT=process.argv[2];
(async()=>{const b=await chromium.launch({args:['--allow-file-access-from-files']});const p=await b.newPage({viewport:{width:1920,height:1080}});
 await p.goto('file://'+require('path').join(__dirname,'video.html'));await p.evaluate(()=>window.ready);
 const total=await p.evaluate(()=>window.TOTAL), N=Math.round(total*FPS);
 const ff=spawn('ffmpeg',['-loglevel','error','-y','-f','image2pipe','-framerate',String(FPS),'-c:v','mjpeg','-i','-','-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',OUT],{stdio:['pipe','inherit','inherit']});
 for(let i=0;i<N;i++){await p.evaluate(t=>render(t),i/FPS);const buf=await p.screenshot({type:'jpeg',quality:92});
   if(!ff.stdin.write(buf)) await new Promise(r=>ff.stdin.once('drain',r)); if(i%240===0) console.log('frame',i,'/',N);}
 ff.stdin.end();await new Promise(r=>ff.on('close',r));await b.close();console.log('DONE',OUT);})();
