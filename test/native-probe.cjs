'use strict'
const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

function post(message) {
  const parentPort = process.parentPort
  if (parentPort !== undefined) parentPort.postMessage(message)
  else if (typeof process.send === 'function') process.send?.(message)
}

function findPnpmPackage(name) {
  const pnpmDir = join(process.cwd(), 'node_modules/.pnpm')
  if (!existsSync(pnpmDir)) return undefined
  const entry = readdirSync(pnpmDir).find(dir => dir.startsWith(`${name}@`) && !dir.includes('_'))
  if (entry === undefined) return undefined
  const candidate = join(pnpmDir, entry, 'node_modules', name)
  return existsSync(candidate) ? candidate : undefined
}

async function probe() {
  const results = {}

  try {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    db.prepare('INSERT INTO t (v) VALUES (?)').run('probe')
    const row = db.prepare('SELECT v FROM t WHERE id = 1').get()
    db.close()
    results.nodeSqlite = row?.v === 'probe'
  } catch (error) {
    results.nodeSqlite = false
    results.nodeSqliteError = String(error)
  }

  const koffiPath = findPnpmPackage('koffi')
  if (koffiPath === undefined) {
    results.koffi = false
    results.koffiError = 'koffi not found in pnpm store'
  } else {
    try {
      const koffi = require(koffiPath)
      results.koffiModule = koffiPath
      const libc = koffi.load('/usr/lib/libSystem.B.dylib')
      const getpid = libc.func('int getpid()')
      results.koffi = typeof koffi.load === 'function' && getpid() > 0
    } catch (error) {
      results.koffi = false
      results.koffiError = String(error)
    }
  }

  const nodePtyPath = findPnpmPackage('node-pty')
  if (nodePtyPath === undefined) {
    results.nodePty = false
    results.nodePtyError = 'node-pty not found in pnpm store'
  } else {
    try {
      const pty = require(nodePtyPath)
      results.nodePtyModule = nodePtyPath
      const child = pty.spawn('/bin/sh', ['-c', 'echo pty-ok'], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
      })
      results.nodePty = await new Promise(resolve => {
        let out = ''
        const timer = setTimeout(() => { child.kill(); resolve(out.includes('pty-ok')) }, 5000)
        child.onData(data => {
          out += data
          if (out.includes('pty-ok')) { clearTimeout(timer); resolve(true) }
        })
        child.onExit(() => { clearTimeout(timer); resolve(out.includes('pty-ok')) })
      })
    } catch (error) {
      results.nodePty = false
      results.nodePtyError = String(error)
    }
  }

  try {
    const { Worker } = require('node:worker_threads')
    results.workerThread = await new Promise(resolve => {
      const worker = new Worker('parentPort.postMessage({ok:true})', { eval: true })
      const timer = setTimeout(() => { worker.terminate(); resolve(false) }, 5000)
      worker.on('message', message => {
        if (message?.ok === true) { clearTimeout(timer); resolve(true) }
      })
      worker.on('error', () => { clearTimeout(timer); resolve(false) })
    })
  } catch (error) {
    results.workerThread = false
    results.workerThreadError = String(error)
  }

  results.execPath = process.execPath
  results.nodeVersion = process.versions.node
  results.electronVersion = process.versions.electron ?? null
  results.platform = process.platform
  results.arch = process.arch
  return results
}

probe().then(results => { post({ type: 'native-probe', results }); setTimeout(() => { process.exit(0) }, 200) })
