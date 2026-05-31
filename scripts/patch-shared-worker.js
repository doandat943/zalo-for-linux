const fs = require('fs');
const path = require('path');

const targetDir = path.join(__dirname, "..", "app", "pc-dist");
const files = fs.readdirSync(targetDir);
const mainstartupFile = files.find(file => /^shared-worker\.[a-f0-9]+\.js$/.test(file));

async function main() {
    console.log("Patching shared-worker...");
    count=0;
    if (!mainstartupFile) {
        console.error("shared-worker file not found in the specified directory.");
        process.exit(1);
    }

    const mainstartupFilePath = path.join(targetDir, mainstartupFile);
    let content = fs.readFileSync(mainstartupFilePath, 'utf-8');

    // Replace the specific code block with the new code
    if (content.includes('if(s===ae.MSG_UNKNOWN)return void 0;let r=e.parsedIdTo||this.idStore.get(e.ownerId),a=e.parsedUidFrom||e.fromId==e.userId?"0":this.idStore.get(e.fromId);if(!a||!r)return void 0;let i=e.msg,o=e.attachData;')) {
        content = content.replace('if(s===ae.MSG_UNKNOWN)return void 0;let r=e.parsedIdTo||this.idStore.get(e.ownerId),a=e.parsedUidFrom||e.fromId==e.userId?"0":this.idStore.get(e.fromId);if(!a||!r)return void 0;let i=e.msg,o=e.attachData;', 
            'if(s===ae.MSG_UNKNOWN)return void 0;const m=e=>{if("string"!=typeof e||!e)return e;const t=e.indexOf("||");if(t>=0){const s=e.slice(t+2).trim();if(s&&("{"===s[0]||"["===s[0]))return s}return e},y=e=>{if("string"!=typeof e||!e)return null;const t=m(e);if("string"!=typeof t||!t)return null;try{const e=JSON.parse(t);return e&&"object"==typeof e?e:null}catch{return null}};let r=e.parsedIdTo||this.idStore.get(e.ownerId)||e.ownerId,a=e.parsedUidFrom||(e.fromId==e.userId?"0":(this.idStore.get(e.fromId)||e.fromId));if(!a||!r)return void 0;let i=m(e.msg),o=e.attachData;const c0=y(i);c0&&c0.data&&"object"==typeof c0.data&&(o.attach||(o.attach={}),Object.assign(o.attach,c0.data));');
        fs.writeFileSync(mainstartupFilePath, content, 'utf-8');
        count++;
        console.log("1. patched successfully.");
    }

    if (content.includes('e=await this._filterDeletedMessages(e);const t=await this._insertMessage(e);')) {
        content = content.replace('e=await this._filterDeletedMessages(e);const t=await this._insertMessage(e);', 
            'e=await this._filterDeletedMessages(e);const t=await this._insertMessage(e);console.error("[SYNC] insertToDb(v1) input=",null==e?void 0:e.length,"ok=",null===(s=t.success)||void 0===s?void 0:s.length,"fail=",null===(r=t.fail)||void 0===r?void 0:r.length);var s,r;')
            fs.writeFileSync(mainstartupFilePath, content, 'utf-8');
        count++;
        console.log("2. patched successfully.");
    }

    const targetRegex = /l\.localDttm=Date\.now\(\),l\.src=ae\.MSG_SRC\.SYNC_MOBILE_DB,l\.sequenceId=e\.sequenseId,l\.uidSenderDel=n,l\.msgType!==ae\.MSG_UNKNOWN\?t\.push\(l\):this\.logger\.zsymb\(0,"([A-Za-z0-9]+)",\(\(\)=>\["skip message: unknown type",\{/g;

    if (targetRegex.test(content)) {
        content = content.replace(targetRegex, (match, randomCode) => {
            return String.raw`l.localDttm=Date.now(),l.src=ae.MSG_SRC.SYNC_MOBILE_DB,l.sequenceId=e.sequenseId,l.uidSenderDel=n;const p=e.localPathRaw;"string"==typeof p&&p.length>3&&/^[\x20-\x7E]+$/.test(p)&&(l.localPath=p),l.msgType!==ae.MSG_UNKNOWN?t.push(l):this.logger.zsymb(0,"flow15",(()=>["skip message: unknown type",{`;
        });
        fs.writeFileSync(mainstartupFilePath, content, 'utf-8');
        count++;
        console.log("3. patched successfully.");
    }

    if (content.includes('const t=this.noiseIdStore.get(e.ownerId);')) {
        content = content.replaceAll('const t=this.noiseIdStore.get(e.ownerId);', 
            'const t=this.noiseIdStore.get(e.ownerId)||e.ownerId;')
            fs.writeFileSync(mainstartupFilePath, content, 'utf-8');
        count++;
        console.log("4. patched successfully.");
    }

    if (content.includes('let r=e.parsedIdTo||this.idStore.get(e.ownerId),a=e.parsedUidFrom||e.fromId==e.userId?"0":this.idStore.get(e.fromId);')) {
        content = content.replace('let r=e.parsedIdTo||this.idStore.get(e.ownerId),a=e.parsedUidFrom||e.fromId==e.userId?"0":this.idStore.get(e.fromId);', 
            'let r=e.parsedIdTo||this.idStore.get(e.ownerId)||e.ownerId,a=e.parsedUidFrom||(e.fromId==e.userId?"0":(this.idStore.get(e.fromId)||e.fromId));')
            fs.writeFileSync(mainstartupFilePath, content, 'utf-8');
        count++;
        console.log("5. patched successfully.");
    }

    if (content.includes('e=await this._filterDeletedMessages(e);const t=await this._insertMessage(e);return se.mediaRes.start()')) {
        content = content.replace('e=await this._filterDeletedMessages(e);const t=await this._insertMessage(e);return se.mediaRes.start()', 
            'e=await this._filterDeletedMessages(e);const t=await this._insertMessage(e);console.error("[SYNC] insertToDb(v2) input=",null==e?void 0:e.length,"ok=",null===(s=t.success)||void 0===s?void 0:s.length,"fail=",null===(r=t.fail)||void 0===r?void 0:r.length);var s,r;return se.mediaRes.start()')
            fs.writeFileSync(mainstartupFilePath, content, 'utf-8');
        count++;
        console.log("6. patched successfully.");
    }

    if (content.includes('this.noiseUserId=void 0,this._db=void 0,this.plainUserId=void 0,this.logger=void 0,this.noiseId=void 0,this._db=$zsqlite.createConnection(e.path,{OPEN_CREATE:!0,OPEN_READWRITE:!0}),this.logger=e.logger,this.noiseUserId=e.noiseUserId,this.plainUserId=e.plainUserId,this.noiseId=e.noiseId')) {
        content = content.replace('this.noiseUserId=void 0,this._db=void 0,this.plainUserId=void 0,this.logger=void 0,this.noiseId=void 0,this._db=$zsqlite.createConnection(e.path,{OPEN_CREATE:!0,OPEN_READWRITE:!0}),this.logger=e.logger,this.noiseUserId=e.noiseUserId,this.plainUserId=e.plainUserId,this.noiseId=e.noiseId', 
            String.raw`this.noiseUserId=void 0,this._db=void 0,this.plainUserId=void 0,this.logger=void 0,this.noiseId=void 0,this.backupConvId="",this._db=$zsqlite.createConnection(e.path,{OPEN_CREATE:!0,OPEN_READWRITE:!0}),this.logger=e.logger,this.noiseUserId=e.noiseUserId,this.plainUserId=e.plainUserId,this.noiseId=e.noiseId;const t=/([g]?\d+)\.db$/i.exec(e.path || "");t && t[1] && (this.backupConvId=t[1].replace(/^g/i,""))`)
            fs.writeFileSync(mainstartupFilePath, content, 'utf-8');
        count++;
        console.log("7. patched successfully.");
    }

    if (content.includes('convertCrossV2ToCrossV1(e){const t=Be[e.MsgType];if(!t)return null;const s=qe.parseBinNet(e.BinNet)||{};if(s.result>0)return this.logger.zsymb(21')) {
        content = content.replace('convertCrossV2ToCrossV1(e){const t=Be[e.MsgType];if(!t)return null;const s=qe.parseBinNet(e.BinNet)||{};if(s.result>0)return this.logger.zsymb(21', 
            String.raw`convertCrossV2ToCrossV1(e){const t=Be[e.MsgType]||"webchat";const _Buf="undefined"!=typeof Buffer&&Buffer&&Buffer.from?Buffer:("undefined"!=typeof globalThis&&globalThis.Buffer&&globalThis.Buffer.from?globalThis.Buffer:("function"==typeof require?(e=>{try{return require("buffer").Buffer}catch{return null}})():null));let _bin=e.BinNet;try{if(_Buf&&_bin&&!_Buf.isBuffer(_bin)){if("undefined"!=typeof ArrayBuffer&&ArrayBuffer.isView&&ArrayBuffer.isView(_bin)&&_bin.buffer){_bin=_Buf.from(new Uint8Array(_bin.buffer,_bin.byteOffset||0,_bin.byteLength||_bin.length||0))}else if(_bin instanceof Uint8Array)_bin=_Buf.from(_bin);else if(_bin&&_bin.buffer&&typeof _bin.byteLength==="number")_bin=_Buf.from(new Uint8Array(_bin.buffer,_bin.byteOffset||0,_bin.byteLength));else if(Array.isArray(_bin)&&_bin.length&&"number"==typeof _bin[0])_bin=_Buf.from(_bin);else if(_bin&&"Buffer"===_bin.type&&Array.isArray(_bin.data))_bin=_Buf.from(_bin.data);else if(_bin&&Array.isArray(_bin.data)&&_bin.data.length&&"number"==typeof _bin.data[0])_bin=_Buf.from(_bin.data);else if(_bin&&"number"==typeof _bin.length&&_bin.length>0&&"number"==typeof _bin[0]){const a=new Array(_bin.length);for(let i=0;i<_bin.length;i++)a[i]=_bin[i]&255;_bin=_Buf.from(a)}else if("string"==typeof _bin){const b=_bin.trim();if(/^[0-9a-fA-F]+$/.test(b)&&b.length%2==0)_bin=_Buf.from(b,"hex");else if(/^[A-Za-z0-9+/]+={0,2}$/.test(b)&&b.length>=16)_bin=_Buf.from(b,"base64");else if(b.includes("\\u00")){const unesc=b.replace(/\\u([0-9a-fA-F]{4})/g,((_,h)=>String.fromCharCode(parseInt(h,16))));_bin=_Buf.from(unesc,"binary")}else _bin=_Buf.from(b,"binary")}}}catch{}const s=qe.parseBinNet(_bin)||{};let r=s.data||{};const n=e=>{if(null===e||void 0===e)return"";const t=String(e);return/^g\d+$/.test(t)?t.slice(1):t};const a=[e.SenderId,e.FromId,e.fromId,e.FromUid,e.fromUid,r.fromD,r.uid,r.ownerId].find((e=>null!==e&&void 0!==e&&""!==e));const i=[e.OwnerId,e.ownerId,e.ToId,e.toId,e.ReceiverId,e.ConversationId,this.backupConvId,this.noiseId].find((e=>null!==e&&void 0!==e&&""!==e));const o=null!==a&&void 0!==a?a:this.noiseId;s.result>0&&(this.logger.zsymb(21`)
            fs.writeFileSync(mainstartupFilePath, content, 'utf-8');
        count++;
        console.log("8. patched successfully.");
    }

    if (content.includes('{message:s.error_message,result:s.result,innerError:s.inner_error}),null;const r=s.data;return r.attachs&&r.attachs.length>0&&r.attachs[0]&&(e.MsgType===$e.OA?r.attach=r.attachs:(r.attach=r.attachs[0],e.MsgType!==$e.Sticker&&r.attach&&delete r.attach.catId)),{fromId:e.SenderId.toString(),fromName:"",attach:"{}",attachData:r,globalMsgId:e.GlbMsgId,cliMsgId:e.CliMsgId,msg:e.MsgContent,ownerId:this.noiseId,ownerType:0,sequenseId:e.TimeStamp,ts:e.TimeStamp,ttl:e.TTL,type:t,userId:this.plainUserId}}')) {
        content = content.replace('{message:s.error_message,result:s.result,innerError:s.inner_error}),null;const r=s.data;return r.attachs&&r.attachs.length>0&&r.attachs[0]&&(e.MsgType===$e.OA?r.attach=r.attachs:(r.attach=r.attachs[0],e.MsgType!==$e.Sticker&&r.attach&&delete r.attach.catId)),{fromId:e.SenderId.toString(),fromName:"",attach:"{}",attachData:r,globalMsgId:e.GlbMsgId,cliMsgId:e.CliMsgId,msg:e.MsgContent,ownerId:this.noiseId,ownerType:0,sequenseId:e.TimeStamp,ts:e.TimeStamp,ttl:e.TTL,type:t,userId:this.plainUserId}}', 
            '{message:s.error_message,result:s.result,innerError:s.inner_error,msgType:e.MsgType,cliMsgId:e.CliMsgId}),r={});this._debugCrossV2ShapePrinted||(this._debugCrossV2ShapePrinted=!0,console.error("[SYNC] CrossV2 row shape sample "+JSON.stringify({keys:Object.keys(e||{}),binNet:{type:typeof e.BinNet,hasBuffer:!!_Buf,isBuffer:_Buf&&_Buf.isBuffer?_Buf.isBuffer(e.BinNet):!1,coercedIsBuffer:_Buf&&_Buf.isBuffer?_Buf.isBuffer(_bin):!1,len:e.BinNet&&(e.BinNet.length||e.BinNet.byteLength||0),coercedLen:_bin&&(_bin.length||_bin.byteLength||0),ctor:e.BinNet&&e.BinNet.constructor?e.BinNet.constructor.name:"",keys0:e.BinNet&&"object"==typeof e.BinNet?Object.keys(e.BinNet).slice(0,8):[]},parseBinNet:{result:s.result,inner_error:s.inner_error,error_message:s.error_message,dataKeys0:r&&"object"==typeof r?Object.keys(r).slice(0,12):[],attachsLen:r&&r.attachs&&r.attachs.length?r.attachs.length:0,attach0Keys0:r&&r.attachs&&r.attachs[0]&&"object"==typeof r.attachs[0]?Object.keys(r.attachs[0]).slice(0,16):[],debug:s&&s.debug?{inputLen:s.debug.inputLen,tlvEndian:s.debug.tlvEndian,topKeyCount:s.debug.topKeyCount,topKeys0:s.debug.topKeys&&s.debug.topKeys.length?s.debug.topKeys.slice(0,16):[],attachCount:s.debug.attachCount,attachCandidateCount:s.debug.attachCandidateCount,attachCandidates0:s.debug.attachCandidates&&s.debug.attachCandidates.length?s.debug.attachCandidates.slice(0,6):[]}:{}},senderCandidates:{SenderId:e.SenderId,FromId:e.FromId,fromId:e.fromId,FromUid:e.FromUid,fromUid:e.fromUid,fromD:r.fromD},ownerCandidates:{OwnerId:e.OwnerId,ownerId:e.ownerId,ToId:e.ToId,ReceiverId:e.ReceiverId,ConversationId:e.ConversationId,backupConvId:this.backupConvId,fallbackNoiseId:this.noiseId},chosen:{fromIdRaw:o,fromIdNormalized:n(o),ownerIdRaw:i,ownerIdNormalized:n(i)}})));return r.attachs&&r.attachs.length>0&&r.attachs[0]&&(e.MsgType===$e.OA?r.attach=r.attachs:(r.attach=r.attachs[0],e.MsgType!==$e.Sticker&&r.attach&&delete r.attach.catId)),{fromId:n(o),fromName:"",attach:"{}",attachData:r,globalMsgId:e.GlbMsgId,cliMsgId:e.CliMsgId,msg:e.MsgContent,ownerId:n(i),ownerType:0,sequenseId:e.TimeStamp,ts:e.TimeStamp,ttl:e.TTL,localPathRaw:e.LocalPath,type:t,userId:this.plainUserId}}')
            fs.writeFileSync(mainstartupFilePath, content, 'utf-8');
        count++;
        console.log("9. patched successfully.");
    }

    if (content.includes('if(e.abort.aborted)return Promise.reject(new Error("Aborted"));const t=st(e.params.format);return ye(e.params.shouldUseNewMediaDBFlowConfig),t.restoreConversations(e)}})||rt);var at;Object(y.j)()(at=Object(l.injectable)()(at=class extends q.a{getType(){return"RESTORE_MESSAGES"}async execute(e){if(e.abort.aborted)return Promise.reject(new Error("Aborted"));const t=st(e.params.format);return ye(e.params.shouldUseNewMediaDBFlowConfig),t.restoreMessages(e)}}')) {
        content = content.replace('if(e.abort.aborted)return Promise.reject(new Error("Aborted"));const t=st(e.params.format);return ye(e.params.shouldUseNewMediaDBFlowConfig),t.restoreConversations(e)}})||rt);var at;Object(y.j)()(at=Object(l.injectable)()(at=class extends q.a{getType(){return"RESTORE_MESSAGES"}async execute(e){if(e.abort.aborted)return Promise.reject(new Error("Aborted"));const t=st(e.params.format);return ye(e.params.shouldUseNewMediaDBFlowConfig),t.restoreMessages(e)}}', 
            'if(e.abort.aborted)return Promise.reject(new Error("Aborted"));const t=st(e.params.format);return console.error("[SYNC] RESTORE_CONVERSATIONS start format=",e.params.format),ye(e.params.shouldUseNewMediaDBFlowConfig),t.restoreConversations(e).then((t=>(console.error("[SYNC] RESTORE_CONVERSATIONS done count=",null!=t&&t.length?t.length:0),t)))}})||rt);var at;Object(y.j)()(at=Object(l.injectable)()(at=class extends q.a{getType(){return"RESTORE_MESSAGES"}async execute(e){if(e.abort.aborted)return Promise.reject(new Error("Aborted"));const t=st(e.params.format);return console.error("[SYNC] RESTORE_MESSAGES start format=",e.params.format),ye(e.params.shouldUseNewMediaDBFlowConfig),t.restoreMessages(e).then((t=>(console.error("[SYNC] RESTORE_MESSAGES done"),t)))}}')
            fs.writeFileSync(mainstartupFilePath, content, 'utf-8');
        count++;
        console.log("10. patched successfully.");
    }

    if (content.includes('async _decryptBackupFormat1(e,t,s,r,a){t=await Object(Qe.a)(t);')) {
        content = content.replace('async _decryptBackupFormat1(e,t,s,r,a){t=await Object(Qe.a)(t);', 
            'async _decryptBackupFormat1(e,t,s,r,a){t=await Object(Qe.a)(t);try{const dirList=await Qe.c(t);console.error("[SYNC] decrypt output dir=",t,"entries=",null==dirList ? void 0:dirList.length,"sample=",(dirList || []).slice(0,10))}catch (err){console.error("[SYNC] decrypt output dir inspect failed:",t,err && (err.message || err))}')
            fs.writeFileSync(mainstartupFilePath, content, 'utf-8');
        count++;
        console.log("11. patched successfully.");
    }
    if (count===11){
        console.log("All patches applied successfully.");
    } else {
        console.warn(`Patching completed with ${count} patches applied. Please verify if all intended patches were applied correctly.`);
    }
}


module.exports = { main };