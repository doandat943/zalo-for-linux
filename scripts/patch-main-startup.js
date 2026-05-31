const fs = require('fs');
const path = require('path');

const targetDir = path.join(__dirname, "..", "app", "pc-dist", "lazy");
const files = fs.readdirSync(targetDir);
const mainstartupFile = files.find(file => /^main-startup\.[a-f0-9]+\.js$/.test(file));

async function main() {
    console.log("Starting to patch main-startup...");
    if (!mainstartupFile) {
        console.error("main-startup file not found in the specified directory.");
        process.exit(1);
    }

    const mainstartupFilePath = path.join(targetDir, mainstartupFile);
    let content = fs.readFileSync(mainstartupFilePath, 'utf-8');

    // Replace the specific code block with the new code
    if (content.includes('try{if(e.convId&&!this.isNewDeleteEvent(e.convId,e.initialDeleteTime))return void s(new ip({code:"CANCEL_DELETE_CONVERSATION",message:`${e.convId} Delete batch messages is canceled`}));const a=await this.getDeleteInfoByThread(e);')) {
        content = content.replace('try{if(e.convId&&!this.isNewDeleteEvent(e.convId,e.initialDeleteTime))return void s(new ip({code:"CANCEL_DELETE_CONVERSATION",message:`${e.convId} Delete batch messages is canceled`}));const a=await this.getDeleteInfoByThread(e);', 
            'try{const r0="string"==typeof e.convId&&e.convId.startsWith("g")?e.convId.slice(1):e.convId;r0&&r0!==e.convId&&(e=Object(I.a)(Object(I.a)({},e),{},{convId: r0}));if(e.convId&&this.isNewDeleteEvent(e.convId,e.initialDeleteTime))return void s(new Vg({code:"CANCEL_DELETE_CONVERSATION",message:`${e.convId} Delete batch messages is canceled`}));let a=await this.getDeleteInfoByThread(e);if(!a&&"string"==typeof e.convId&&e.convId.startsWith("g"))try{const t=e.convId.slice(1);a=await this.getDeleteInfoByThread(Object(I.a)(Object(I.a)({},e),{},{convId:t}))}catch(i){}')
        fs.writeFileSync(mainstartupFilePath, content, 'utf-8');
        console.log("main-startup patched successfully.");
    } else {
        console.error("The specified code block was not found in main-startup.");
        process.exit(1);
    }
}

module.exports = { main };
