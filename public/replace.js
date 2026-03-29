const fs = require('fs');
const path = require('path');
const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

for (const f of files) {
    let content = fs.readFileSync(path.join(dir, f), 'utf8');
    let original = content;
    
    content = content.replace(/localStorage\.(getItem|setItem|removeItem)\('itecify-(auth-token|current-user|workspace-id)'/g, 'sessionStorage.$1(\'itecify-$2\'');
    
    if (content !== original) {
        fs.writeFileSync(path.join(dir, f), content);
        console.log('Updated ' + f);
    }
}
