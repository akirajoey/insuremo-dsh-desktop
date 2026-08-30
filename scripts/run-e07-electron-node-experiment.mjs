import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appPath = resolve(process.argv[2] ?? join(root, 'release/mac-arm64/InsureMO DSH Desktop.app/Contents/MacOS/InsureMO DSH Desktop'))
const harnessRoot = join(dirname(dirname(appPath)), 'Resources/dsh-runtime/harness')
const pnpmEntry = join(dirname(harnessRoot), 'pnpm/bin/pnpm.cjs')
const outputPath = process.env.DSH_ELECTRON_NODE_OUTPUT ?? 'docs/evidence/e07-electron-node-experiment.json'

if (!existsSync(appPath)) throw new Error('packaged Electron executable is missing')
if (!existsSync(harnessRoot)) throw new Error('packaged harness resource is missing')

function runNode(code, timeoutMs = 30_000) {
  const result = spawnSync(appPath, ['-e', code], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_ROOT: harnessRoot, DSH_EXPERIMENT_PNPM: pnpmEntry },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`probe exited ${result.status}: ${(result.stderr ?? '').slice(-500)}`)
  return (result.stdout ?? '').trim()
}

function assertOutput(code, expected, timeoutMs = 30_000, label = expected) {
  try {
    const output = runNode(code, timeoutMs)
    if (!output.includes(expected)) throw new Error(`probe did not report ${expected}; output=${JSON.stringify(output.slice(-500))}`)
    return output
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function runHarnessSmoke() {
  const plugin = process.env.DSH_TEST_PLUGIN_TGZ ?? '/tmp/e04-test-plugin.tgz'
  if (!existsSync(plugin)) throw new Error('packaged smoke plugin fixture is missing')
  const result = spawnSync(process.execPath, ['scripts/run-e07-packaged-smoke.mjs', appPath], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, DSH_DESKTOP_EXPERIMENT_ELECTRON_NODE: '1', DSH_TEST_PLUGIN_TGZ: plugin, DSH_TEST_AUTO_QUIT_AFTER_MS: '45000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`packaged harness smoke exited ${result.status}`)
  const smoke = JSON.parse(result.stdout)
  if (smoke.ok !== true || smoke.normal?.settings?.imo?.current !== '0.2.20' || smoke.normal?.settings?.skills?.installed <= 0) {
    throw new Error('packaged harness smoke did not prove normal/safe/plugin/Settings')
  }
  return { ok: true, normal: true, safe: true, plugin: true, settings: true, cleanup: smoke.orphanWrappers?.length === 0 && smoke.homeDshUnchanged === true }
}

function main() {
  const probes = {}
  probes.nodeVersion = JSON.parse(assertOutput("console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron}))", '"node":"24.18.1"', 30_000, 'node version'))
  probes.workerThreads = assertOutput("const {Worker}=require('node:worker_threads');const w=new Worker(\"require('node:worker_threads').parentPort.postMessage('worker-ok')\",{eval:true});w.once('message',m=>{console.log(m);w.terminate()})", 'worker-ok', 30_000, 'worker_threads')
  probes.sqlite = assertOutput("const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE t (n INTEGER)');db.prepare('INSERT INTO t VALUES (42)').run();console.log(db.prepare('SELECT n FROM t').get().n)", '42', 30_000, 'node:sqlite')
  probes.nativeModules = assertOutput("const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');const root=path.join(process.env.HARNESS_ROOT,'node_modules/.pnpm');const koffiDir=fs.readdirSync(root).find(name=>name.startsWith('koffi@'));const koffi=createRequire(path.join(root,koffiDir,'node_modules/koffi/package.json'))('.');const localDir=fs.readdirSync(root).find(name=>name.startsWith('@deepseek-ai+dsh-subprocess-local@'));const local=createRequire(path.join(root,localDir,'node_modules/@deepseek-ai/dsh-subprocess-local/package.json'));const pty=local('node-pty');console.log(JSON.stringify({koffi:typeof koffi,pty:typeof pty.spawn}))", '"koffi":"object"', 30_000, 'native modules')
  probes.pty = assertOutput("const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');const root=path.join(process.env.HARNESS_ROOT,'node_modules/.pnpm');const localDir=fs.readdirSync(root).find(name=>name.startsWith('@deepseek-ai+dsh-subprocess-local@'));const pty=createRequire(path.join(root,localDir,'node_modules/@deepseek-ai/dsh-subprocess-local/package.json'))('node-pty');const t=pty.spawn('/bin/sh',['-c','printf pty-ok'],{name:'xterm',cols:80,rows:25,cwd:process.cwd(),env:process.env});let s='';t.onData(x=>s+=x);t.onExit(()=>console.log(s))", 'pty-ok', 30_000, 'node-pty')
  probes.forkIpc = assertOutput("const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {fork}=require('node:child_process');const d=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-electron-fork-'));const f=path.join(d,'child.cjs');fs.writeFileSync(f,\"process.send?.('fork-ok');process.disconnect?.()\");const c=fork(f,[],{execPath:process.execPath,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','ignore','ipc']});c.on('message',m=>{console.log(m);fs.rmSync(d,{recursive:true,force:true})})", 'fork-ok')
  probes.pnpmAdd = assertOutput("const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawnSync}=require('node:child_process');const d=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-electron-pnpm-'));const src=path.join(d,'fixture');fs.mkdirSync(src);fs.writeFileSync(path.join(src,'package.json'),JSON.stringify({name:'dsh-electron-node-fixture',version:'1.0.0'}));const out=spawnSync(process.execPath,[process.env.DSH_EXPERIMENT_PNPM,'add','--save-exact','--ignore-scripts','file:'+src],{cwd:d,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8'});if(out.status!==0)throw new Error(out.stderr);console.log(JSON.parse(fs.readFileSync(path.join(d,'node_modules/dsh-electron-node-fixture/package.json'))).version);fs.rmSync(d,{recursive:true,force:true})", '1.0.0', 120_000, 'pnpm add')
  probes.agentWorker = JSON.parse(assertOutput("(async()=>{const fs=require('node:fs'),path=require('node:path');const {createRequire}=require('node:module');const {pathToFileURL}=require('node:url');const root=path.join(process.env.HARNESS_ROOT,'node_modules/.pnpm');const workerDir=fs.readdirSync(root).find(name=>name.startsWith('@deepseek-ai+dsh-code-runtime-worker-thread@'));const r=createRequire(path.join(root,workerDir,'node_modules/@deepseek-ai/dsh-code-runtime-worker-thread/package.json'));const cordis=await import(pathToFileURL(r.resolve('@deepseek-ai/cordis')).href);const mod=await import(pathToFileURL(r.resolve('@deepseek-ai/dsh-code-runtime-worker-thread')).href);const ctx=new cordis.Context();const fiber=await ctx.plugin(mod.WorkerThreadCodeRuntime,{});const result=await ctx.codeRuntime.run({program:'return 40 + 2',bindings:[]});await fiber.dispose();console.log(JSON.stringify({value:result.value,error:result.error?.kind??null,isolation:'worker-thread'}))})().catch(e=>{console.error(e);process.exit(1)})", '"value":42', 60_000, 'agent worker'))
  probes.harness = runHarnessSmoke()
  return { schema: 'Electron run-as-Node experiment v1', app: basename(appPath), platform: process.platform, arch: process.arch, probes }
}

let result
try {
  result = { ok: true, ...main() }
} catch (error) {
  result = { ok: false, app: basename(appPath), platform: process.platform, arch: process.arch, error: String(error).replace(/(?:\/Users\/|\/private\/|\/tmp\/)[^\s'"`]+/g, '<path>') }
}
const output = resolve(root, outputPath)
writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
