// Inventory only the exact root lock and installed package notices. No network,
// package lifecycle scripts, credential discovery, or inferred license grants.
import {readFile,readdir,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)))
const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'))
const entries=Object.entries(lock.packages).filter(([path,value])=>path.includes('node_modules/')&&value.version&&!value.link&&typeof value.resolved==='string')
const name=path=>path.split('node_modules/').at(-1)
const clean=value=>String(value??'').replaceAll('\t',' ').replaceAll('\n',' ')
const inventory=['lockfile\tpackage\tversion\tdeclared_license\tdevelopment\toptional\tarchive']
for(const [path,p] of entries)inventory.push(['package-lock.json',p.name??name(path),p.version,p.license??'',p.dev===true,p.optional===true,p.resolved].map(clean).join('\t'))
const packages=new Map()
for(const [path,p] of entries){const key=(p.name??name(path))+'@'+p.version;const current=packages.get(key)??{name:p.name??name(path),version:p.version,paths:[]};current.paths.push(path);packages.set(key,current)}
const notices=['Third-party license and notice files from the locked Linux x64 npm installation.\nOriginal upstream texts follow without modification. See THIRD_PARTY_NOTICES.md for scope and omissions.\n']
const missing=['package\tversion\tcoverage_limitation']
for(const p of [...packages.values()].sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version,'en'))){
  let installed=false;const texts=new Map()
  for(const path of p.paths){
    let files;try{files=await readdir(join(root,path))}catch(error){if(error.code==='ENOENT')continue;throw error}
    const installedPackage=JSON.parse(await readFile(join(root,path,'package.json'),'utf8'))
    if(installedPackage.version!==p.version)throw Error('Installed version differs from lock: '+p.name)
    installed=true
    for(const file of files.filter(file=>/^(?:licen[cs]e|notice|copying)(?:[.\-_]|$)/i.test(file)).sort()){
      let contents;try{contents=await readFile(join(root,path,file),'utf8')}catch(error){if(error.code==='EISDIR')continue;throw error}
      texts.set(file+'\0'+contents,{file,contents})
    }
  }
  if(!texts.size)missing.push([p.name,p.version,installed?'no top-level license/notice file in installed package':'not installed for this platform'].join('\t'))
  for(const {file,contents} of texts.values())notices.push('\n===== '+p.name+'@'+p.version+' / '+file+' =====\n'+contents+(contents.endsWith('\n')?'':'\n'))
}
const outputs={'npm-inventory.tsv':inventory.join('\n')+'\n','notice-coverage.tsv':missing.join('\n')+'\n','npm-NOTICES.txt':notices.join('\n')}
for(const [file,contents] of Object.entries(outputs)){
  const path=join(root,'third-party',file)
  if(process.argv.includes('--check')){if(await readFile(path,'utf8')!==contents)throw Error('Regenerate '+file)}
  else await writeFile(path,contents)
}
console.log(JSON.stringify({occurrences:entries.length,distinct:packages.size,coverageLimitations:missing.length-1}))
